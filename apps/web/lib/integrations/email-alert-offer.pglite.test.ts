import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailAlertAddHandler } from '~/lib/channel/router/handlers';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import type { HandlerContext, HandlerVerdict, ResolvedAnswer } from '~/lib/channel/router/route';
import { defaultReminderRunDeps, runReminderCron } from '~/lib/loop/reminders/run';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { EMAIL_ALERT_EVENT_DURATION_MS, EMAIL_ALERT_OFFER_TTL_MS } from './email-alert-offer';

/**
 * THE YES AT THE END OF AN EMAIL ALERT, against the real DDL.
 *
 * pglite rather than fakes, because everything that could be wrong here is SQL: which
 * `source` the reminder scheduler and the weekly-plan composer each read (they agree on
 * exactly one value), the partial index behind "is this offer still open", the guarded
 * update that claims the placement, and the arbitration that decides whether a bare YES
 * belongs to this offer at all. A fake reader answers all four from whatever it was
 * handed.
 *
 * The ARBITRATION case is built out of real rows on purpose: a drafted `actions` row and
 * an offer row, read by the SHIPPED `defaultOpenQuestionReader`. #649's bug was a YES
 * landing on the wrong question, so "it is not stolen" has to be proven by the reader
 * production uses, not by a hand-built list.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };

const NOW = new Date('2026-09-17T15:00:00.000Z');
/** Inside the reminder scheduler's 8-day horizon, and a Saturday morning in Toronto. */
const STARTS_AT = new Date('2026-09-19T13:00:00.000Z');
const TITLE = 'Picture day';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  // The voice stage is an LLM call and this suite is about the week, not the wording.
  vi.stubEnv('VOICE_DISABLED', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The outbound row an alert would have claimed — the offer's provenance, and NOT NULL,
 * so every offer in this suite hangs off a text that actually went out. */
async function sentAlert(): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: 'connector:email_alert',
      dedupeKey: `email_alert:${randomUUID()}:m1`,
      status: 'sent',
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no ledger row');
  return row.id;
}

async function seedOffer(
  over: Partial<typeof schema.emailAlertOffers.$inferInsert> = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.emailAlertOffers)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: randomUUID(),
      messageId: randomUUID(),
      kind: 'new_event',
      title: TITLE,
      startsAt: STARTS_AT,
      location: 'the gym',
      channelMessageId: await sentAlert(),
      expiresAt: new Date(NOW.getTime() + EMAIL_ALERT_OFFER_TTL_MS),
      ...over,
    })
    .returning({ id: schema.emailAlertOffers.id });
  if (!row) throw new Error('no offer row');
  return row.id;
}

/** One inbound turn, with the open-question list the router would have read. Defaults to
 * the SHIPPED reader over this family's real rows. */
async function turn(
  body: string,
  over: { resolved?: ResolvedAnswer; open?: 'real' | 'none' } = {},
): Promise<HandlerContext> {
  const open =
    over.open === 'none'
      ? []
      : await defaultOpenQuestionReader().open(db.database, {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          now: NOW,
        });
  return {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    conversationId: randomUUID(),
    body,
    send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' as const }),
    now: NOW,
    resolved: over.resolved ?? null,
    openQuestions: async () => open,
    inboundChannelMessageId: randomUUID(),
  };
}

function reply(body: string, over?: Parameters<typeof turn>[1]): Promise<HandlerVerdict> {
  return turn(body, over).then((ctx) => emailAlertAddHandler().handle(db.database, ctx));
}

/** A drafted change waiting for this family's approval — the other open question. */
async function seedDraftedAction(): Promise<void> {
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: family.familyId,
      source: 'channel_sms',
      eventType: 'channel_sms.calendar_intent',
      dedupHash: randomUUID(),
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('no event row');
  await db.database.insert(schema.actions).values({
    familyId: family.familyId,
    eventId: event.id,
    actionType: 'calendar_add',
    payload: { title: 'Swim lessons' },
    userVisibleState: 'drafted_for_approval',
    reviewerVerdict: 'approved',
  });
}

function events() {
  return db.database
    .select()
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.familyId, family.familyId));
}

function offers() {
  return db.database
    .select()
    .from(schema.emailAlertOffers)
    .where(eq(schema.emailAlertOffers.familyId, family.familyId));
}

describe('a YES puts the occasion on the family week', () => {
  it('writes ONE family_events row at the offered instant, and answers with it', async () => {
    await seedOffer();

    const verdict = await reply('yes');

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.reply).toBe(
      "Added - Picture day on Saturday, Sep 19 at 9:00 a.m. It's on your week; say remove it anytime.",
    );

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: TITLE,
      location: 'the gym',
      // The ONE source both the reminder scheduler and the weekly-plan composer read.
      source: 'parent',
      createdBy: family.parentUserId,
      // The extraction's childRef is suggestive, never a binding — so no child is named,
      // and the teen gate is never handed a guess (rule #1).
      childId: null,
      sensitive: false,
      deletedAt: null,
    });
    // The INSTANT, not a wall clock: the offer carried an ISO instant and no timezone
    // arithmetic happens on this path.
    expect(rows[0]?.startsAt.toISOString()).toBe(STARTS_AT.toISOString());
    expect(rows[0]?.endsAt?.getTime()).toBe(STARTS_AT.getTime() + EMAIL_ALERT_EVENT_DURATION_MS);

    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, family.familyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: family.parentUserId,
      actionTaken: 'email_alert_event_added',
      targetTable: 'family_events',
      targetId: rows[0]?.id,
      // Enums only — never the title, never the place (rule #1).
      after: { kind: 'new_event' },
    });
  });

  it('closes the offer only once the receipt has actually gone', async () => {
    // The MEM-10 discipline. A turn that placed the event and then failed to answer must
    // leave the question standing, so the redrive finds it.
    await seedOffer();

    const verdict = await reply('yes');
    if (!verdict.claimed) throw new Error('unreachable');
    await expect(offers()).resolves.toMatchObject([{ resolvedAt: null, resolution: null }]);

    await verdict.afterSend?.(randomUUID());
    const [closed] = await offers();
    expect(closed?.resolution).toBe('added');
    expect(closed?.resolvedAt).not.toBeNull();
  });

  it('places nothing twice when the turn is re-driven before the receipt landed', async () => {
    // The event insert is CLAIMED against the offer, so the second pass conflicts on the
    // primary key instead of putting a second Saturday on the week.
    await seedOffer();

    await reply('yes');
    const secondPass = await reply('yes');

    expect(secondPass).toMatchObject({ claimed: true, outcome: 'added' });
    await expect(events()).resolves.toHaveLength(1);
    // And the append-only audit carries ONE claim that a calendar entry was created.
    const audit = await db.database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, family.familyId));
    expect(audit).toHaveLength(1);
  });

  it('answers a NO by resolving the offer as declined, and writes no event', async () => {
    await seedOffer();

    const verdict = await reply('no');

    expect(verdict).toMatchObject({ claimed: true, outcome: 'declined' });
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.reply).toBe('Okay - left it off.');
    await expect(events()).resolves.toHaveLength(0);

    await verdict.afterSend?.(randomUUID());
    await expect(offers()).resolves.toMatchObject([{ resolution: 'declined', eventId: null }]);
  });

  it('answers a SECOND yes with what is already there, and adds nothing', async () => {
    const offerId = await seedOffer();
    const first = await reply('yes');
    if (!first.claimed) throw new Error('unreachable');
    await first.afterSend?.(randomUUID());

    // The offer is closed now, so nothing is listed and `soleOpenKind` is vacuously true
    // — which is exactly why the repeat branch has to find a row of its own.
    const repeat = await reply('yes');

    expect(repeat).toMatchObject({ claimed: true, outcome: 'already_added' });
    if (!repeat.claimed) throw new Error('unreachable');
    expect(repeat.reply).toBe('Already on your week - Picture day on Saturday, Sep 19 at 9:00 a.m.');
    await expect(events()).resolves.toHaveLength(1);
    expect(offerId).toBeTruthy();
  });

  it('lets the word go to the coach once the repeat window has passed', async () => {
    // The POSITIVE CONTROL for the test above: the same state, read eleven minutes later,
    // claims nothing. Without this the repeat branch could be claiming every bare "yes" a
    // household ever sends and the test above would still be green.
    await seedOffer();
    const first = await reply('yes');
    if (!first.claimed) throw new Error('unreachable');
    await first.afterSend?.(randomUUID());

    const late = await turn('yes');
    const verdict = await emailAlertAddHandler().handle(db.database, {
      ...late,
      now: new Date(NOW.getTime() + 11 * 60 * 1000),
    });

    expect(verdict).toEqual({ claimed: false });
  });

  it('does not claim a yes for an EXPIRED offer', async () => {
    await seedOffer({ expiresAt: new Date(NOW.getTime() - 1000) });

    await expect(reply('yes')).resolves.toEqual({ claimed: false });
    await expect(events()).resolves.toHaveLength(0);
  });

  it('does not claim a yes for a CO-PARENT who never saw the text', async () => {
    await seedOffer();
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Co Parent' })
      .returning({ id: schema.users.id });
    if (!coParent) throw new Error('no co-parent');
    const ctx = await turn('yes');

    const verdict = await emailAlertAddHandler().handle(db.database, {
      ...ctx,
      parentUserId: coParent.id,
    });

    expect(verdict).toEqual({ claimed: false });
    await expect(events()).resolves.toHaveLength(0);
  });

  it('claims nothing at all when this family has no offer', async () => {
    await expect(reply('yes', { open: 'none' })).resolves.toEqual({ claimed: false });
  });
});

describe('a bare YES is never stolen from another open question', () => {
  it('declines while a drafted action is also waiting', async () => {
    // The shape #649 removed the sentence over: with one unrelated action pending, a bare
    // YES used to approve THAT one. Built out of real rows and read by the SHIPPED reader.
    await seedOffer();
    await seedDraftedAction();

    const ctx = await turn('yes');
    // The POSITIVE CONTROL for the arbitration: both questions really are listed.
    expect((await ctx.openQuestions()).map((q) => q.kind).sort()).toEqual([
      'approval',
      'email_alert_add',
    ]);

    await expect(emailAlertAddHandler().handle(db.database, ctx)).resolves.toEqual({
      claimed: false,
    });
    await expect(events()).resolves.toHaveLength(0);
    await expect(offers()).resolves.toMatchObject([{ resolvedAt: null }]);
  });

  it('acts on a RESOLVED answer even with another question open', async () => {
    // The other half: the resolver named which question this is, which is what the wait
    // exists to establish, so the handler acts.
    const offerId = await seedOffer();
    await seedDraftedAction();

    const verdict = await reply('go ahead and put that on my week', {
      resolved: {
        kind: 'email_alert_add',
        questionId: offerId,
        polarity: 'yes',
        confidence: 'high',
      },
    });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    await expect(events()).resolves.toHaveLength(1);
  });
});

describe('what the week does with it', () => {
  it('is picked up by the reminder scheduler, through the shipped deps', async () => {
    // The whole point of `source = 'parent'`: a text the day before something the parent
    // only ever saw in an email. Driven through `defaultReminderRunDeps`, because the gate
    // is a source filter inside `loadHorizonEvents` and no fake of it can be asked
    // whether the real filter admits this row.
    await seedOffer();
    await reply('yes');
    const [event] = await events();
    if (!event) throw new Error('no event');

    const result = await runReminderCron(db.database, defaultReminderRunDeps(), NOW);

    expect(result.converged).toBeGreaterThan(0);
    const reminders = await db.database
      .select()
      .from(schema.eventReminders)
      .where(
        and(
          eq(schema.eventReminders.eventRef, event.id),
          eq(schema.eventReminders.parentUserId, family.parentUserId),
        ),
      );
    expect(reminders.map((row) => row.offset).sort()).toEqual(['-P1D', '-PT1H']);
    expect(reminders.every((row) => row.status === 'scheduled')).toBe(true);
  });

  it('is in the weekly-plan composer window too, unlike a placement', async () => {
    // The composer excludes `placement`, the scheduler admits only `placement` and
    // `parent`. `parent` is the intersection, and this pins it: change the source and one
    // of these two tests goes red.
    await seedOffer();
    await reply('yes');

    const { listFamilyEventsInWindow } = await import('~/lib/loop/queries');
    const inWindow = await listFamilyEventsInWindow(
      db.database,
      family.familyId,
      new Date(NOW.getTime() - 86_400_000),
      new Date(NOW.getTime() + 8 * 86_400_000),
    );
    expect(inWindow.map((row) => row.title)).toEqual([TITLE]);
  });
});
