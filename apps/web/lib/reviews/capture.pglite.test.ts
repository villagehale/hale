import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityFollowupAskDedupeKey } from '~/lib/channel/followup/ask-open';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import {
  ACTIVITY_REVIEWS_ENABLED_ENV,
  type ReviewCaptureResult,
  VERDICT_AUDIT_VERB,
  runReviewCapture,
} from './capture';
import type { VerdictOutcome, VerdictReader } from './verdict';

/**
 * WHAT COMES BACK AFTER "HOW DID IT GO?" — the pass, against real Postgres.
 *
 * THE SCREENS ARE THE POINT OF THIS FILE. Each one has a positive control on the same
 * shape, and each asserts that the verdict reader was NEVER INVOKED: a screen that ran
 * after the model call would be a screen that leaked, and an absence test with nothing
 * beside it fails open.
 *
 * The reader is faked here and that is not rule #8 being bent — the MODEL's judgement is
 * measured by `eval:activity-verdict` against real cached Claude, and what this file
 * measures is everything around it: which replies reach it at all, what is written, and
 * what the trail says.
 */

const NOW = new Date('2026-09-16T00:30:00.000Z'); // 20:30 America/Toronto
const ASKED_AT = new Date('2026-09-16T00:00:00.000Z'); // 20:00 America/Toronto
const REPLIED_AT = new Date('2026-09-16T00:10:00.000Z');
const PLACE_REF = 'places/riverdale-library';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env[ACTIVITY_REVIEWS_ENABLED_ENV] = 'true';
});

afterEach(async () => {
  process.env[ACTIVITY_REVIEWS_ENABLED_ENV] = undefined;
  await db.exec('truncate table families, users cascade');
});

/** Counts every call, so a screen that leaked past the model is a failing assertion
 * rather than a missing one. */
function fakeReader(outcome: VerdictOutcome): VerdictReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(body) {
      calls.push(body);
      return outcome;
    },
  };
}

const WORTH_IT: VerdictOutcome = {
  status: 'read',
  verdict: 'worth_it',
  tags: ['hard_parking'],
  tagsDropped: 0,
};

interface Seeded {
  familyId: string;
  parentUserId: string;
  coParentUserId: string;
  childId: string;
  familyEventId: string;
  askMessageId: string;
}

interface SeedOptions {
  areaCoarse?: string | null;
  childDateOfBirth?: string;
  sensitive?: boolean;
  /** Omit the provenance so the subject cannot be resolved. */
  withProvenance?: boolean;
  placeId?: string | null;
  civicVenueId?: string | null;
}

async function seed(options: SeedOptions = {}): Promise<Seeded> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Ana + kids',
      provinceOrState: 'ON',
      areaCoarse: options.areaCoarse === undefined ? 'M4K' : options.areaCoarse,
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;

  const [primary] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:capture-primary-${familyId}`, name: 'Ana' })
    .returning({ id: schema.users.id });
  const [coParent] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:capture-coparent-${familyId}`, name: 'Sam' })
    .returning({ id: schema.users.id });
  const parentUserId = primary?.id as string;
  const coParentUserId = coParent?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: parentUserId, role: 'primary_parent' },
    { familyId, userId: coParentUserId, role: 'co_parent' },
  ]);

  const [child] = await db.database
    .insert(schema.children)
    .values({
      familyId,
      name: 'Mia',
      dateOfBirth: options.childDateOfBirth ?? '2023-03-01',
    })
    .returning({ id: schema.children.id });
  const childId = child?.id as string;

  const [candidate] = await db.database
    .insert(schema.villageCandidates)
    .values({
      familyId,
      title: 'Saturday storytime',
      kind: 'class',
      summary: 'a warm local option',
      source: 'web_grounded',
      confidence: 0.9,
      placeId: options.placeId === undefined ? PLACE_REF : options.placeId,
      civicVenueId: options.civicVenueId ?? null,
    })
    .returning({ id: schema.villageCandidates.id });

  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source: 'channel',
      eventType: 'channel_message',
      dedupHash: `capture-${familyId}`,
    })
    .returning({ id: schema.events.id });
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event?.id as string,
      familyId,
      actionType: 'calendar_add',
      userVisibleState: 'autonomous',
      payload: {
        title: 'Saturday storytime',
        startsAt: '2026-09-12T14:00:00.000Z',
        ...(options.withProvenance === false
          ? {}
          : { sourceRef: { table: 'village_candidates', id: candidate?.id as string } }),
      },
    })
    .returning({ id: schema.actions.id });

  const [placement] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      childId,
      title: 'Saturday storytime',
      startsAt: new Date('2026-09-12T14:00:00.000Z'),
      source: 'placement',
      sensitive: options.sensitive ?? false,
      placedByActionId: action?.id as string,
    })
    .returning({ id: schema.familyEvents.id });
  const familyEventId = placement?.id as string;

  const [ask] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'followup',
      templateKey: 'followup:activity',
      dedupeKey: activityFollowupAskDedupeKey(familyEventId),
      status: 'sent',
      createdAt: ASKED_AT,
    })
    .returning({ id: schema.channelMessages.id });

  return {
    familyId,
    parentUserId,
    coParentUserId,
    childId,
    familyEventId,
    askMessageId: ask?.id as string,
  };
}

async function seedReply(
  seeded: Seeded,
  body: string,
  options: { parentUserId?: string; createdAt?: Date } = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: options.parentUserId ?? seeded.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body,
      createdAt: options.createdAt ?? REPLIED_AT,
    })
    .returning({ id: schema.channelMessages.id });
  return row?.id as string;
}

async function run(
  reader: VerdictReader,
  now: Date = NOW,
): Promise<ReviewCaptureResult> {
  const { activityFollowupAskOpen } = await import('~/lib/channel/followup/ask-open');
  return runReviewCapture(db.database, { askOpen: activityFollowupAskOpen, verdict: reader, now });
}

async function reviewRows(familyId: string) {
  return db.database
    .select()
    .from(schema.activityReviews)
    .where(eq(schema.activityReviews.familyId, familyId));
}

async function verdictAuditRows(familyId: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, VERDICT_AUDIT_VERB),
      ),
    );
}

describe('the dark flag', () => {
  it("treats a trailing newline as OFF — `vercel env add` from a piped echo stores 'true\\n'", async () => {
    const seeded = await seed();
    await seedReply(seeded, 'She loved it.');
    process.env[ACTIVITY_REVIEWS_ENABLED_ENV] = 'true\n';
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.skipped).toBe('flag_off');
    expect(reader.calls).toEqual([]);
    expect(await reviewRows(seeded.familyId)).toEqual([]);
  });

  it('runs on the exact literal, which is the positive control for the case above', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'She loved it.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.skipped).toBeNull();
    expect(result.recorded).toBe(1);
  });
});

describe('what is recorded', () => {
  it('writes one row, with the resolved subject, the area key and the age band', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'Loved it, parking was a nightmare though.');

    const result = await run(fakeReader(WORTH_IT));

    expect(result.recorded).toBe(1);
    const [row] = await reviewRows(seeded.familyId);
    expect({
      subjectSource: row?.subjectSource,
      subjectRef: row?.subjectRef,
      areaKey: row?.areaKey,
      childAgeBand: row?.childAgeBand,
      verdict: row?.verdict,
      tags: row?.tags,
    }).toEqual({
      subjectSource: 'place',
      subjectRef: PLACE_REF,
      // M4K is Toronto, which stays FSA-exact — a municipality there would be three
      // million people in one bucket.
      areaKey: 'M4K',
      childAgeBand: 'toddler',
      verdict: 'worth_it',
      tags: ['hard_parking'],
    });
  });

  it('writes a trail row naming the verdict and the tag COUNT, and never the tags, the ref, the area or the band', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'Loved it, parking was a nightmare though.');

    await run(fakeReader(WORTH_IT));

    const [audit] = await verdictAuditRows(seeded.familyId);
    expect(audit?.after).toEqual({
      stored: true,
      verdict: 'worth_it',
      tagCount: 1,
      subjectSource: 'place',
      updated: false,
    });
    // Asserted against the SERIALISED payload rather than a field list, so a future
    // field carrying one of these fails too.
    const serialised = JSON.stringify(audit?.after);
    expect(serialised).not.toContain('hard_parking');
    expect(serialised).not.toContain(PLACE_REF);
    expect(serialised).not.toContain('M4K');
    expect(serialised).not.toContain('toddler');
    expect(audit?.targetTable).toBe('channel_messages');
  });

  /** The model was called, so the parent's words were processed, so there is a row —
   * even though nothing was stored. Deleting that write is the mutation. */
  it('writes a trail row for a read that stored nothing', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'It was fine.');

    const result = await run(fakeReader({ status: 'no_verdict', tagsDropped: 0 }));

    expect(result.noVerdict).toBe(1);
    expect(await reviewRows(seeded.familyId)).toEqual([]);
    const [audit] = await verdictAuditRows(seeded.familyId);
    expect(audit?.after).toEqual({
      stored: false,
      verdict: null,
      tagCount: 0,
      subjectSource: 'place',
      updated: false,
    });
  });

  it('counts a tag the model invented and writes only the eight', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'Loved it.');

    const result = await run(
      fakeReader({ status: 'read', verdict: 'worth_it', tags: ['well_run'], tagsDropped: 2 }),
    );

    expect(result.tagsDropped).toBe(2);
    const [row] = await reviewRows(seeded.familyId);
    expect(row?.tags).toEqual(['well_run']);
  });

  it('corrects the first answer rather than counting a second household', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'Loved it.');
    await run(fakeReader(WORTH_IT));
    const [first] = await reviewRows(seeded.familyId);

    // A second reply, a second tick. The ask is still standing.
    await seedReply(seeded, 'Actually it was not great.', {
      createdAt: new Date('2026-09-16T00:20:00.000Z'),
    });
    const result = await run(
      fakeReader({ status: 'read', verdict: 'not_worth_it', tags: [], tagsDropped: 0 }),
    );

    expect({ recorded: result.recorded, updated: result.updated }).toEqual({
      recorded: 0,
      updated: 1,
    });
    const rows = await reviewRows(seeded.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('not_worth_it');
    expect(rows[0]?.createdAt).toEqual(first?.createdAt);
  });

  it('does not pay a second model call for a reply it already read', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'Loved it.');
    await run(fakeReader(WORTH_IT));

    const reader = fakeReader(WORTH_IT);
    const result = await run(reader);

    expect(result.alreadyRead).toBe(1);
    expect(reader.calls).toEqual([]);
  });

  it('names a thrown extraction rather than swallowing it', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'Loved it.');

    const result = await run(
      fakeReader({ status: 'extraction_failed', reason: 'schema mismatch' }),
    );

    expect(result.extractionFailed).toBe(1);
    expect(await reviewRows(seeded.familyId)).toEqual([]);
  });

  it('defers rather than guessing when the model cannot be reached', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'Loved it.');

    const result = await run(fakeReader({ status: 'deferred', reason: 'client_unavailable' }));

    expect(result.deferred).toBe(1);
    expect(await reviewRows(seeded.familyId)).toEqual([]);
  });
});

describe('the screens — each one runs BEFORE the model', () => {
  it("refuses a 13+ child's placement, and never calls the model (rule #1)", async () => {
    const seeded = await seed({ childDateOfBirth: '2010-03-01' });
    await seedReply(seeded, 'She loved it.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.teenScoped).toBe(1);
    expect(reader.calls).toEqual([]);
    expect(await reviewRows(seeded.familyId)).toEqual([]);
    expect(await verdictAuditRows(seeded.familyId)).toEqual([]);
  });

  it('records the same reply for a toddler — the control for the teen screen', async () => {
    const seeded = await seed({ childDateOfBirth: '2023-03-01' });
    await seedReply(seeded, 'She loved it.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.recorded).toBe(1);
    expect(reader.calls).toEqual(['She loved it.']);
  });

  it('refuses a sensitive placement, and never calls the model', async () => {
    const seeded = await seed({ sensitive: true });
    await seedReply(seeded, 'She loved it.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.sensitiveEvent).toBe(1);
    expect(reader.calls).toEqual([]);
    expect(await reviewRows(seeded.familyId)).toEqual([]);
  });

  it('refuses a reply Hale does not write down (EN)', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'It clashed with her therapy appointment so we left early.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.notKept).toBe(1);
    expect(reader.calls).toEqual([]);
    expect(await reviewRows(seeded.familyId)).toEqual([]);
  });

  it('refuses a reply Hale does not write down (FR)', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'On est partis tot, elle avait un rendez-vous chez le medecin.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.notKept).toBe(1);
    expect(reader.calls).toEqual([]);
  });

  /** The control for both: a neighbouring innocuous reply through the same path DOES
   * record, so the two absences above are the screen and not a broken pass. */
  it('records an innocuous reply on the same shape', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'We left a bit early but she had a good time.');
    const reader = fakeReader(WORTH_IT);

    expect((await run(reader)).recorded).toBe(1);
  });

  it('refuses a placement whose subject cannot be resolved, by reason, with no model call', async () => {
    const seeded = await seed({ withProvenance: false });
    await seedReply(seeded, 'She loved it.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.subjectUnresolved.no_provenance_in_payload).toBe(1);
    expect(reader.calls).toEqual([]);
  });

  it('refuses a household whose area is not FSA-shaped — "near you" would be a city', async () => {
    const seeded = await seed({ areaCoarse: 'Toronto' });
    await seedReply(seeded, 'She loved it.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.noAreaKey).toBe(1);
    expect(reader.calls).toEqual([]);
  });
});

describe('which reply is the answer', () => {
  it("does not read the co-parent's text as the household's answer", async () => {
    const seeded = await seed();
    await seedReply(seeded, 'Can you move Thursday swim?', {
      parentUserId: seeded.coParentUserId,
    });
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.wrongParent).toBe(1);
    expect(reader.calls).toEqual([]);
  });

  it('counts an ask nobody answered', async () => {
    await seed();
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect({ asksExamined: result.asksExamined, noReply: result.noReply }).toEqual({
      asksExamined: 1,
      noReply: 1,
    });
    expect(reader.calls).toEqual([]);
  });

  it('counts an ask that something else closed before the parent wrote back', async () => {
    const seeded = await seed();
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      templateKey: 'nudge:something-else',
      status: 'sent',
      createdAt: new Date('2026-09-16T00:05:00.000Z'),
    });
    await seedReply(seeded, 'She loved it.');
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader);

    expect(result.askClosed).toBe(1);
    expect(reader.calls).toEqual([]);
  });

  /** The ask lapses at 08:00 local, and a tick after that must still capture a reply
   * that arrived while the question was standing. */
  it('reads a reply that arrived before the lapse even when the tick runs after it', async () => {
    const seeded = await seed();
    await seedReply(seeded, 'She loved it.', {
      createdAt: new Date('2026-09-16T11:50:00.000Z'), // 07:50 Toronto
    });
    const reader = fakeReader(WORTH_IT);

    const result = await run(reader, new Date('2026-09-16T12:05:00.000Z')); // 08:05 Toronto

    expect(result.recorded).toBe(1);
    expect(reader.calls).toEqual(['She loved it.']);
  });
});
