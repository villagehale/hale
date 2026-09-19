import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveApproval } from '~/lib/channel/router/approval';
import { matchFastPath } from '~/lib/channel/router/fast-path';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { approvedShortlistAskedOf } from './prepare-reply';
import { defaultSequenceReplyDeps, handleSequenceReply } from './reply';
import { legDedupeKey } from './run';

/**
 * ONE HOUSEHOLD ROW, TWO PARENTS ANSWERING IT — against the real DDL, the real approval
 * spine and the real loaders (audit 2026-09-17 r1).
 *
 * The ladder's legs now reach every parent seat, so the two things that were always
 * true of one number have to be true of two: the shortlist is approved ONCE however
 * many parents say yes, and the registration morning is resolved ONCE however many
 * report it. Both properties live entirely in SQL — `user_visible_state =
 * 'drafted_for_approval'` in the pending list, `outcome IS NULL` in the check-in loader
 * — and a fake spine or a fake loader states them rather than proves them, which is how
 * both survived a mutation with 1,199 tests green.
 *
 * THE ONLY MOCK IS THE QUEUE, because pg-boss is another process. Everything that
 * decides anything here is the production function reading production tables.
 */

const queued: Array<{ actionId: string; approvedBy: string }> = [];
vi.mock('~/lib/queue', () => ({
  getQueue: async () => ({
    send: async (_name: string, payload: { action_id: string; approved_by: string }) => {
      queued.push({ actionId: payload.action_id, approvedBy: payload.approved_by });
      return 'job-1';
    },
  }),
}));

/** The morning ran four and a half hours ago: inside the check-in leg's own window
 * (four hours after the open, open for 72) and past the instant the ladder anchored on,
 * which is what `awaitingOutcome` reads. */
const OPEN_AT = new Date('2026-09-15T10:30:00.000Z');
const NOW = new Date('2026-09-15T15:00:00.000Z');
/** Before the morning, which is the only time the already-approved ack is true. */
const PRE_OPEN_NOW = new Date('2026-09-14T12:00:00.000Z');

let db: TestDb;
let familyId: string;
let primaryUserId: string;
let coParentUserId: string;
let windowId: string;
let sequenceId: string;
let actionId: string;
/** The window registry is unique on (municipality, domain, cycle), so each case gets
 * its own cycle rather than its own municipality — the town is load-bearing here (the
 * FSA resolves to it) and the label is not. */
let cycles = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  queued.length = 0;
  await db.exec('truncate table families, users cascade');
});

beforeEach(async () => {
  const seeded = await seedFamily(db.database, `Two Parents ${Math.random()}`);
  familyId = seeded.familyId;
  primaryUserId = seeded.parentUserId;
  await db.database
    .update(schema.families)
    .set({ areaCoarse: 'L3R', onboardingStage: 'sms_active' })
    .where(eq(schema.families.id, familyId));

  const [partner] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:two-parents-${Math.random()}`, name: 'Sam' })
    .returning({ id: schema.users.id });
  coParentUserId = partner?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: coParentUserId, role: 'co_parent' });

  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2021-09-01', dobPrecision: 'exact' });

  cycles += 1;
  const [window] = await db.database
    .insert(schema.registrationWindows)
    .values({
      municipality: 'markham',
      programDomain: 'rec_program',
      cycleLabel: `Fall 2026 #${cycles}`,
      openAt: OPEN_AT,
      ageMinMonths: 36,
      ageMaxMonths: 84,
      waitlistResponseHours: 36,
      sourceUrl: 'https://www.markham.ca/register',
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    })
    .returning({ id: schema.registrationWindows.id });
  windowId = window?.id as string;

  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source: 'test',
      eventType: 'registration_shortlist',
      dedupHash: `two-parents-${Math.random()}`,
    })
    .returning({ id: schema.events.id });
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event?.id as string,
      familyId,
      actionType: 'send_message',
      payload: {},
      // The card as the ladder leaves it: held for the parent, cleared by the reviewer
      // (rule #3), executed by nobody yet.
      userVisibleState: 'drafted_for_approval',
      reviewerVerdict: 'approved',
      draftedAt: new Date('2026-09-08T10:00:00.000Z'),
    })
    .returning({ id: schema.actions.id });
  actionId = action?.id as string;

  const [sequence] = await db.database
    .insert(schema.registrationSequences)
    // The PRIMARY parent's seat claimed the window, which is what every sequence row
    // looks like: the claim is minted by a cron, not by whoever answers.
    .values({ familyId, windowId, parentUserId: primaryUserId, actionId })
    .returning({ id: schema.registrationSequences.id });
  sequenceId = sequence?.id as string;
});

/** The production spine, whole — including the refusal mapping a hand-built one in a
 * test would have to restate. */
async function say(body: string, parentUserId: string) {
  const { defaultApprovalSpine } = await import('~/lib/channel/router/wiring');
  const command = matchFastPath(body);
  if (!command) throw new Error(`test bug: ${JSON.stringify(body)} is not a command`);
  return resolveApproval(
    db.database,
    { familyId, parentUserId, command, now: NOW },
    defaultApprovalSpine(),
  );
}

/** What the worker does to an approved draft, and the state every reader downstream
 * calls "the parent opted in". */
async function executeTheDraft(): Promise<void> {
  await db.database
    .update(schema.actions)
    .set({ userVisibleState: 'autonomous', executedAt: new Date('2026-09-08T10:05:00.000Z') })
    .where(eq(schema.actions.id, actionId));
}

async function auditRows(verb: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));
}

describe('one shortlist card, both parents answering', () => {
  it('lets the co-parent’s YES approve it, stamped with them', async () => {
    const outcome = await say('yes', coParentUserId);

    expect(outcome.status).toBe('approved');
    expect(queued).toEqual([{ actionId, approvedBy: coParentUserId }]);
  });

  /**
   * THE SECOND YES, through the list that decides it. Kills deleting
   * `user_visible_state = 'drafted_for_approval'` from `defaultApprovalSpine.listPending`
   * (mutation M3b, which survived 59 files of router, journey, sequence and coach
   * tests): without it the executed row is still listed, the second YES binds to it,
   * and `approveDraftedAction` answers 409 — a `conflict` receipt telling a parent
   * something went wrong when what actually happened is that the household is
   * registered for.
   */
  it('does not let the primary parent’s later YES claim the executed row', async () => {
    await say('yes', coParentUserId);
    await executeTheDraft();
    queued.length = 0;

    const second = await say('yes', primaryUserId);

    expect(second).toEqual({ status: 'declined_to_claim', reply: null, actionId: null });
    expect(queued).toEqual([]);
  });

  /**
   * And what that unclaimed YES is answered WITH. The heads-up ("Reply YES and I'll run
   * the morning with you") is still Hale's last word to this parent, so the reader hands
   * the registration handler a true sentence instead of leaving a model to invent one.
   */
  it('is answerable: the ask is still this parent’s last word, on a card already approved', async () => {
    await executeTheDraft();
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId: primaryUserId,
      channel: 'sms',
      direction: 'out',
      category: 'registration_sequence',
      templateKey: 'registration_sequence:heads_up',
      dedupeKey: legDedupeKey(familyId, windowId, 'heads_up', primaryUserId),
      status: 'delivered',
      createdAt: new Date('2026-09-08T14:00:00.000Z'),
    });

    expect(
      await approvedShortlistAskedOf(db.database, familyId, primaryUserId, PRE_OPEN_NOW),
    ).toEqual({ sequenceId });
    // The co-parent was never texted that leg — their key is a different row — so
    // nothing is open for them, which is what keeps this from answering any bare yes in
    // the household.
    expect(
      await approvedShortlistAskedOf(db.database, familyId, coParentUserId, PRE_OPEN_NOW),
    ).toBeNull();
  });

  it('says nothing while the card is still waiting — an unapproved shortlist is a real question', async () => {
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId: primaryUserId,
      channel: 'sms',
      direction: 'out',
      category: 'registration_sequence',
      templateKey: 'registration_sequence:heads_up',
      dedupeKey: legDedupeKey(familyId, windowId, 'heads_up', primaryUserId),
      status: 'delivered',
      createdAt: new Date('2026-09-08T14:00:00.000Z'),
    });

    expect(
      await approvedShortlistAskedOf(db.database, familyId, primaryUserId, PRE_OPEN_NOW),
    ).toBeNull();
  });

  /** Anything Hale said after the ask closes it — the last-word rule, which is the only
   * thing keeping this reader from claiming a "yes" that answered something else. */
  it('says nothing once anything newer has gone out to that parent', async () => {
    await executeTheDraft();
    for (const [key, at] of [
      [legDedupeKey(familyId, windowId, 'heads_up', primaryUserId), '2026-09-08T14:00:00.000Z'],
      [null, '2026-09-09T14:00:00.000Z'],
    ] as const) {
      await db.database.insert(schema.channelMessages).values({
        familyId,
        parentUserId: primaryUserId,
        channel: 'sms',
        direction: 'out',
        category: 'registration_sequence',
        dedupeKey: key,
        status: 'delivered',
        createdAt: new Date(at),
      });
    }

    expect(
      await approvedShortlistAskedOf(db.database, familyId, primaryUserId, PRE_OPEN_NOW),
    ).toBeNull();
  });
});

describe('one registration morning, both parents reporting it', () => {
  const reply = (body: string, parentUserId: string) =>
    handleSequenceReply(
      db.database,
      { familyId, parentUserId, body, now: NOW },
      defaultSequenceReplyDeps(),
    );

  beforeEach(async () => {
    await executeTheDraft();
  });

  it('files the co-parent’s report under the co-parent', async () => {
    const outcome = await reply('we got in', coParentUserId);

    expect(outcome.status).toBe('recorded');
    const [audit] = await auditRows('registration_outcome_recorded');
    expect(audit?.actor).toBe(coParentUserId);
    expect(audit?.actor).not.toBe(primaryUserId);
  });

  /**
   * THE HOUSEHOLD'S ROW IS RESOLVED ONCE. Kills deleting `isNull(outcome)` from
   * `loadAwaitingSequence` (mutation M3a, which reply.test.ts could not see because its
   * "already has an outcome" case runs on a fake loader): the pure `awaitingOutcome`
   * check behind it reads `state.outcome`, which this loader hardcodes to null, so that
   * one line of SQL is the ONLY thing standing between a second parent's "we got in"
   * and a second outcome overwriting the first.
   */
  it('hears the primary parent’s later report as a morning already reported', async () => {
    await reply('we got in', coParentUserId);

    const second = await reply('waitlisted #4', primaryUserId);

    expect(second).toEqual({ status: 'ignored', reason: 'no_open_window' });
    expect(await auditRows('registration_outcome_recorded')).toHaveLength(1);
    const [row] = await db.database
      .select({ outcome: schema.registrationSequences.outcome })
      .from(schema.registrationSequences)
      .where(eq(schema.registrationSequences.id, sequenceId));
    expect(row?.outcome).toBe('registered');
  });

  /** THE POSITIVE CONTROL on the case above: the same second message, from the same
   * parent, on a sequence nobody has answered — it must be heard. */
  it('hears either parent while the morning is still unreported', async () => {
    const outcome = await reply('waitlisted #4', primaryUserId);

    expect(outcome.status).toBe('recorded');
    const [audit] = await auditRows('registration_outcome_recorded');
    expect(audit?.actor).toBe(primaryUserId);
  });
});
