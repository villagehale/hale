import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { declineDraftedAction } from '~/lib/actions/decline';
import { findPendingIdenticalCalendarAdd } from '~/lib/channel/coach/draft';
import { groupPlanDraftPort } from '~/lib/channel/group-plan/stamp';
import { emailAlertAddHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext, HandlerVerdict, ResolvedAnswer } from '~/lib/channel/router/route';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { defaultReminderRunDeps, runReminderCron } from '~/lib/loop/reminders/run';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import {
  COACH_CALENDAR_INTEGRATION_ID,
  EMAIL_ALERT_EVENT_DURATION_MS,
  EMAIL_ALERT_OFFER_TTL_MS,
  handleEmailAlertOfferReply,
  loadOpenEmailAlertOffers,
  recordCoachCalendarOffer,
  recordEmailAlertOffer,
} from './email-alert-offer';

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
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, family.parentUserId));
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
      // The alert went out BEFORE anything this suite does with it. Left to default the
      // row would carry the wall clock and read as Hale's newest word, which is the one
      // thing it never is.
      createdAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no ledger row');
  return row.id;
}

/** An outbound row Hale actually sent this parent — the receipt a resolution is closed
 * against, or the unrelated text that takes the last word away from it. */
async function sentOut(at: Date): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      sentAt: at,
      createdAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no ledger row');
  return row.id;
}

/** The receipt a handler's `afterSend` is handed: a real row, because the resolution is
 * closed against the message that carried it. */
function receipt(at: Date = NOW): Promise<string> {
  return sentOut(at);
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

/** The receipt echoes the facts. The test reads the title and the instant, never a template. */
function handler() {
  return emailAlertAddHandler({
    writeReceipt: {
      write: async (facts) => `${facts.happened}|${facts.title}|${facts.when}`,
    },
  });
}

function reading(offerId: string, polarity: 'yes' | 'no'): ResolvedAnswer {
  return { kind: 'email_alert_add', questionId: offerId, polarity, confidence: 'high' };
}

function reply(body: string, over?: Parameters<typeof turn>[1]): Promise<HandlerVerdict> {
  return turn(body, over).then((ctx) => handler().handle(db.database, ctx));
}

/** A drafted change waiting for this family's approval — the other open question. */
async function seedDraftedAction(
  over: { title?: string; startsAt?: string; reviewerVerdict?: 'approved' | 'pending' } = {},
): Promise<string> {
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
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      familyId: family.familyId,
      eventId: event.id,
      actionType: 'calendar_add',
      payload: {
        title: over.title ?? 'Swim lessons',
        ...(over.startsAt ? { startsAt: over.startsAt } : {}),
      },
      userVisibleState: 'drafted_for_approval',
      reviewerVerdict: over.reviewerVerdict ?? 'approved',
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('no action row');
  return action.id;
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
    const offerId = await seedOffer();

    const verdict = await reply('yes', { resolved: reading(offerId, 'yes') });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.reply).toBe('added|Picture day|Saturday, Sep 19 at 9:00 a.m.');

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

  it('stamps the placed event onto the booking born from the same email', async () => {
    // Two rows from ONE email, so the (connection, message) pair addresses both and no
    // third id crosses the router. This is what turns "the parent said yes" into "the
    // follow-up reader will defer to the placement reader, or not".
    const integrationId = randomUUID();
    const messageId = randomUUID();
    const channelMessageId = await sentAlert();
    const offerId = await seedOffer({
      integrationId,
      messageId,
      kind: 'booking_confirmation',
      channelMessageId,
    });
    await db.database.insert(schema.activityBookings).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId,
      messageId,
      providerHost: 'recreation.brookfield.example.ca',
      title: TITLE,
      firstSessionAt: STARTS_AT,
      channelMessageId,
    });

    await expect(reply('yes', { resolved: reading(offerId, 'yes') })).resolves.toMatchObject({
      claimed: true,
      outcome: 'added',
    });

    const [placed] = await events();
    const [booking] = await db.database
      .select()
      .from(schema.activityBookings)
      .where(eq(schema.activityBookings.familyId, family.familyId));
    expect(placed?.id).toBeDefined();
    expect(booking?.eventId).toBe(placed?.id);
  });

  it('leaves the booking alive with a NULL event when the parent says no', async () => {
    // A parent who keeps their own calendar is still booked. The absence of a stamp is
    // the absence of a calendar row, never the absence of the class.
    const integrationId = randomUUID();
    const messageId = randomUUID();
    const channelMessageId = await sentAlert();
    const offerId = await seedOffer({
      integrationId,
      messageId,
      kind: 'booking_confirmation',
      channelMessageId,
    });
    await db.database.insert(schema.activityBookings).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId,
      messageId,
      providerHost: 'recreation.brookfield.example.ca',
      title: TITLE,
      firstSessionAt: STARTS_AT,
      channelMessageId,
    });

    await expect(reply('no', { resolved: reading(offerId, 'no') })).resolves.toMatchObject({
      claimed: true,
      outcome: 'declined',
    });

    await expect(events()).resolves.toHaveLength(0);
    const rows = await db.database
      .select()
      .from(schema.activityBookings)
      .where(eq(schema.activityBookings.familyId, family.familyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventId).toBeNull();
  });

  it('logs rather than swallows a booking offer that placed with no booking to stamp', async () => {
    // `no_booking` is the ordinary answer for the other five kinds. For a
    // `booking_confirmation` it is an inconsistency - the same post-send stretch wrote
    // both rows - and the consequence is that the follow-up ask will never happen, which
    // is exactly the kind of silence rule #11 forbids. Never a throw: the parent's event
    // is already placed and the receipt is already owed.
    const logged = vi.spyOn(console, 'error');
    const offerId = await seedOffer({ kind: 'booking_confirmation' });

    await expect(reply('yes', { resolved: reading(offerId, 'yes') })).resolves.toMatchObject({
      claimed: true,
      outcome: 'added',
    });

    await expect(events()).resolves.toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: family.familyId }),
      expect.stringContaining('no booking row to stamp'),
    );
  });

  it('says nothing for a new_event offer with no booking - the CONTROL for the log above', async () => {
    // Without this, the assertion above passes on an implementation that logs for every
    // placement, which would make the inconsistency invisible in the noise.
    const logged = vi.spyOn(console, 'error');
    const offerId = await seedOffer();

    await expect(reply('yes', { resolved: reading(offerId, 'yes') })).resolves.toMatchObject({
      claimed: true,
      outcome: 'added',
    });

    expect(logged).not.toHaveBeenCalled();
  });

  it('closes the offer only once the receipt has actually gone', async () => {
    // The MEM-10 discipline. A turn that placed the event and then failed to answer must
    // leave the question standing, so the redrive finds it.
    const offerId = await seedOffer();

    const verdict = await reply('yes', { resolved: reading(offerId, 'yes') });
    if (!verdict.claimed) throw new Error('unreachable');
    await expect(offers()).resolves.toMatchObject([{ resolvedAt: null, resolution: null }]);

    await verdict.afterSend?.(await receipt());
    const [closed] = await offers();
    expect(closed?.resolution).toBe('added');
    expect(closed?.resolvedAt).not.toBeNull();
  });

  it('places nothing twice when the turn is re-driven before the receipt landed', async () => {
    // The event insert is CLAIMED against the offer, so the second pass conflicts on the
    // primary key instead of putting a second Saturday on the week.
    const offerId = await seedOffer();

    await reply('yes', { resolved: reading(offerId, 'yes') });
    const secondPass = await reply('yes', { resolved: reading(offerId, 'yes') });

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
    const offerId = await seedOffer();

    const verdict = await reply('no', { resolved: reading(offerId, 'no') });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'declined' });
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.reply).toBe('declined|Picture day|Saturday, Sep 19 at 9:00 a.m.');
    await expect(events()).resolves.toHaveLength(0);

    await verdict.afterSend?.(await receipt());
    await expect(offers()).resolves.toMatchObject([{ resolution: 'declined', eventId: null }]);
  });

  it('does not claim a second yes once the offer is closed', async () => {
    const offerId = await seedOffer();
    const first = await reply('yes', { resolved: reading(offerId, 'yes') });
    if (!first.claimed) throw new Error('unreachable');
    await first.afterSend?.(await receipt());

    // The offer is closed. A reading of that same id is not an invitation to place it
    // again, and there is no repeat-window phrase that answers for the parent.
    const repeat = await reply('yes', { resolved: reading(offerId, 'yes') });

    expect(repeat).toEqual({ claimed: false });
    await expect(events()).resolves.toHaveLength(1);
  });

  it('does not read a bare yes while the offer is still open', async () => {
    // The keyword path is gone. A word with no reading places nothing, even when this
    // family has exactly one offer and the word is "yes".
    await seedOffer();

    await expect(reply('yes')).resolves.toEqual({ claimed: false });
    await expect(events()).resolves.toHaveLength(0);
  });

  it('does not claim a yes for an EXPIRED offer', async () => {
    const offerId = await seedOffer({ expiresAt: new Date(NOW.getTime() - 1000) });

    await expect(reply('yes', { resolved: reading(offerId, 'yes') })).resolves.toEqual({
      claimed: false,
    });
    await expect(events()).resolves.toHaveLength(0);
  });

  it('does not claim a yes for a CO-PARENT who never saw the text', async () => {
    const offerId = await seedOffer();
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Co Parent' })
      .returning({ id: schema.users.id });
    if (!coParent) throw new Error('no co-parent');
    const ctx = await turn('yes', { resolved: reading(offerId, 'yes') });

    const verdict = await handler().handle(db.database, {
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

    await expect(handler().handle(db.database, ctx)).resolves.toEqual({
      claimed: false,
    });
    await expect(events()).resolves.toHaveLength(0);
    await expect(offers()).resolves.toMatchObject([{ resolvedAt: null }]);
  });

  it('treats a reviewer-approved draft of the same occasion as the offer, not a second question', async () => {
    const offerId = await seedOffer();
    const actionId = await seedDraftedAction({
      title: TITLE,
      startsAt: STARTS_AT.toISOString(),
      reviewerVerdict: 'approved',
    });

    const questions = await (await turn('YES')).openQuestions();

    expect(questions.filter((question) => question.kind === 'approval')).toEqual([]);
    expect(questions.find((question) => question.id === offerId)?.approvesActionId).toBe(actionId);
  });

  it('a later YES does not place an add the parent already declined', async () => {
    const offerId = await seedOffer();
    const actionId = await seedDraftedAction({
      title: TITLE,
      startsAt: STARTS_AT.toISOString(),
      reviewerVerdict: 'approved',
    });
    await declineDraftedAction(db.database, {
      actionId,
      familyId: family.familyId,
      declinedBy: family.parentUserId,
    });

    const verdict = await reply('YES', { resolved: reading(offerId, 'yes') });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'declined' });
    await expect(events()).resolves.toHaveLength(0);
  });

  it('a YES still places an afternoon add after a morning refusal of the same title', async () => {
    const afternoon = new Date('2026-09-19T20:00:00.000Z');
    const offerId = await seedOffer({ startsAt: afternoon });
    const actionId = await seedDraftedAction({
      title: TITLE,
      startsAt: STARTS_AT.toISOString(),
      reviewerVerdict: 'approved',
    });
    await declineDraftedAction(db.database, {
      actionId,
      familyId: family.familyId,
      declinedBy: family.parentUserId,
    });

    const verdict = await reply('YES', { resolved: reading(offerId, 'yes') });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    await expect(events()).resolves.toHaveLength(1);
  });

  it('a YES that places the offer retires the unapproved draft of the same add', async () => {
    const offerId = await seedOffer();
    const actionId = await seedDraftedAction({
      title: TITLE,
      startsAt: STARTS_AT.toISOString(),
      reviewerVerdict: 'pending',
    });

    const verdict = await reply('YES', { resolved: reading(offerId, 'yes') });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    await expect(events()).resolves.toHaveLength(1);
    const [action] = await db.database
      .select({ state: schema.actions.userVisibleState, reason: schema.actions.revertedReason })
      .from(schema.actions)
      .where(eq(schema.actions.id, actionId));
    expect(action).toEqual({
      state: 'reverted',
      reason: 'superseded_by_calendar_offer',
    });
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, actionId));
    expect(audits.map((row) => row.actionTaken)).toContain('action.superseded_by_calendar_offer');
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

/**
 * TWO ALERTS IN A DAY IS THE ORDINARY CASE — the outbound gate permits three — so which
 * offer an answer is FOR is a question this path has to be able to answer, not a corner.
 */
describe('two standing offers', () => {
  const OLDER_TITLE = 'Swim class';
  const AN_HOUR = 60 * 60 * 1000;

  /** The older of the two, an hour back, about something else. */
  function seedOlderOffer(
    over: Partial<typeof schema.emailAlertOffers.$inferInsert> = {},
  ): Promise<string> {
    return seedOffer({
      title: OLDER_TITLE,
      location: 'the pool',
      createdAt: new Date(NOW.getTime() - AN_HOUR),
      ...over,
    });
  }

  function resolvedAs(offerId: string, polarity: 'yes' | 'no'): ResolvedAnswer {
    return { kind: 'email_alert_add', questionId: offerId, polarity, confidence: 'high' };
  }

  it('acts on the offer the resolver NAMED, never the newest one', async () => {
    const older = await seedOlderOffer();
    const newer = await seedOffer();

    const verdict = await reply('yes, the swim one', { resolved: resolvedAs(older, 'yes') });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.reply).toContain(OLDER_TITLE);
    await expect(events()).resolves.toMatchObject([{ title: OLDER_TITLE }]);
    // And the one they did not name is untouched: still open, still unplaced.
    const rows = await offers();
    expect(rows.find((row) => row.id === newer)).toMatchObject({
      resolvedAt: null,
      eventId: null,
    });
    expect(rows.find((row) => row.id === older)?.eventId).not.toBeNull();
  });

  it('declines the offer the resolver named, and leaves the other standing', async () => {
    const older = await seedOlderOffer();
    const newer = await seedOffer();

    const verdict = await reply('not the swim one', { resolved: resolvedAs(older, 'no') });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'declined' });
    if (!verdict.claimed) throw new Error('unreachable');
    await verdict.afterSend?.(await receipt());
    const rows = await offers();
    expect(rows.find((row) => row.id === older)?.resolution).toBe('declined');
    expect(rows.find((row) => row.id === newer)?.resolvedAt).toBeNull();
  });

  it('declines to act when the offer the resolver named has stopped being open', async () => {
    // The menu was minted against a text that is a day old now. Acting on "the one they
    // named" by falling back to the newest would add an occasion they never answered.
    const lapsed = await seedOlderOffer({ expiresAt: new Date(NOW.getTime() - 1000) });
    await seedOffer();

    const verdict = await reply('yes', { resolved: resolvedAs(lapsed, 'yes') });

    expect(verdict).toEqual({ claimed: false });
    await expect(events()).resolves.toHaveLength(0);
  });

  it('names them distinctly enough for a parent to pick between them', async () => {
    // What the clarifying sentence is built from. Two questions carrying ONE phrase print
    // "Which one - X, or X?" and no word a parent could send tells them apart.
    await seedOlderOffer();
    await seedOffer();

    const questions = (await (await turn('yes')).openQuestions()).filter(
      (question) => question.kind === 'email_alert_add',
    );

    expect(questions).toHaveLength(2);
    const subjects = questions.map((question) => question.subject);
    expect(new Set(subjects).size).toBe(2);
    expect(subjects.some((subject) => subject.includes(TITLE))).toBe(true);
    expect(subjects.some((subject) => subject.includes(OLDER_TITLE))).toBe(true);
  });

  it('falls back to a position when two of them carry the SAME title', async () => {
    // A school that sends a notice and then a correction about the same occasion. The
    // title cannot separate them, and with the bare YES going to the clarifier this is the
    // only route left — an unpickable menu would strand BOTH offers for the whole day.
    // The position runs oldest-first, so "the first" is the first text they got.
    await seedOlderOffer({ title: TITLE });
    await seedOffer();

    const subjects = (await (await turn('yes')).openQuestions())
      .filter((question) => question.kind === 'email_alert_add')
      .map((question) => question.subject);

    expect(subjects).toEqual([
      `putting ${TITLE} on your week (the first)`,
      `putting ${TITLE} on your week (the second)`,
    ]);
  });

  it('sends a bare YES to the clarifier rather than binding it to the newest', async () => {
    // `soleOpenKind` is about KINDS and is vacuously true for two of one kind, so the
    // ambiguity between them has to be read here. A parent answering the swim text with
    // "yes" must not get picture day on their week.
    await seedOlderOffer();
    await seedOffer();

    const verdict = await reply('yes');

    expect(verdict).toEqual({ claimed: false });
    await expect(events()).resolves.toHaveLength(0);
    await expect(offers()).resolves.toMatchObject([{ resolvedAt: null }, { resolvedAt: null }]);
  });
});

/**
 * VIL-410: a bare YES after a calendar offer put an event that had ALREADY HAPPENED on a
 * real family's week, because the offer stood for a flat day whatever the occasion's own
 * time. An offer is a question about a future occasion; once that occasion has started
 * there is nothing left to put on the week.
 */
describe('an offer never outlives the occasion it is about (VIL-410)', () => {
  const AN_HOUR = 60 * 60 * 1000;

  function record(startsAt: Date, channelMessageId: string) {
    return recordEmailAlertOffer(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: randomUUID(),
      messageId: randomUUID(),
      channelMessageId,
      draft: { kind: 'new_event', title: TITLE, startsAt, location: null },
      now: NOW,
    });
  }

  it('expires at the start of an occasion that begins inside the day', async () => {
    const startsAt = new Date(NOW.getTime() + 2 * AN_HOUR);

    await expect(record(startsAt, await sentAlert())).resolves.toBe('recorded');

    const [offer] = await offers();
    expect(offer?.expiresAt.toISOString()).toBe(startsAt.toISOString());
  });

  it('keeps the full day for an occasion further out - the CONTROL for the cap', async () => {
    await expect(record(STARTS_AT, await sentAlert())).resolves.toBe('recorded');

    const [offer] = await offers();
    expect(offer?.expiresAt.getTime()).toBe(NOW.getTime() + EMAIL_ALERT_OFFER_TTL_MS);
  });

  it('writes no offer for an occasion that has already started', async () => {
    const startedAt = new Date(NOW.getTime() - AN_HOUR);

    await expect(record(startedAt, await sentAlert())).resolves.toBe('event_started');
    await expect(record(NOW, await sentAlert())).resolves.toBe('event_started');

    await expect(offers()).resolves.toEqual([]);
  });

  it('stops listing an offer once its occasion starts, even inside its expiry', async () => {
    // Rows written before the cap carried a flat day. The reader is the one place every
    // answer passes through, so it has to refuse them too.
    await seedOffer({
      title: 'Gymnastics',
      startsAt: new Date(NOW.getTime() - AN_HOUR),
      expiresAt: new Date(NOW.getTime() + 20 * AN_HOUR),
    });
    await seedOffer();

    const open = await loadOpenEmailAlertOffers(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      now: NOW,
    });

    expect(open.map((offer) => offer.title)).toEqual([TITLE]);
  });

  it('answers a named yes after the start with no_open_offer, and places nothing', async () => {
    const offerId = await seedOffer({
      startsAt: new Date(NOW.getTime() - AN_HOUR),
      expiresAt: new Date(NOW.getTime() + 20 * AN_HOUR),
    });

    await expect(
      handleEmailAlertOfferReply(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        offerId,
        polarity: 'yes',
        parentReply: 'yes',
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'no_open_offer' });
    await expect(events()).resolves.toEqual([]);
  });
});

describe('what the week does with it', () => {
  it('is picked up by the reminder scheduler, through the shipped deps', async () => {
    // The whole point of `source = 'parent'`: a text the day before something the parent
    // only ever saw in an email. Driven through `defaultReminderRunDeps`, because the gate
    // is a source filter inside `loadHorizonEvents` and no fake of it can be asked
    // whether the real filter admits this row.
    const offerId = await seedOffer();
    await reply('yes', { resolved: reading(offerId, 'yes') });
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
    const offerId = await seedOffer();
    await reply('yes', { resolved: reading(offerId, 'yes') });

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

/**
 * A coach sentence is not parsed here. The model names a title and an instant; this
 * recorder refuses a start that has passed and an occasion the calendar already holds.
 */
describe('a coach offer is the calendar, not the sentence', () => {
  const SUNDAY = new Date('2026-10-04T13:00:00.000Z');
  const THURSDAY = new Date('2026-10-01T20:15:00.000Z');
  const OCTOBER_SECOND = new Date('2026-10-02T15:00:00.000Z');

  function coach(over: {
    title: string;
    startsAt: Date;
    channelMessageId: string;
    now?: Date;
    location?: string | null;
  }) {
    return recordCoachCalendarOffer(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      location: null,
      now: NOW,
      ...over,
    });
  }

  it('writes no row when the occasion has already started', async () => {
    await expect(
      coach({
        title: 'Gymnastics',
        startsAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        channelMessageId: await sentOut(NOW),
      }),
    ).resolves.toBe('event_started');
    await expect(offers()).resolves.toEqual([]);
  });

  it('writes no row for an empty title', async () => {
    await expect(
      coach({
        title: '   ',
        startsAt: SUNDAY,
        channelMessageId: await sentOut(NOW),
      }),
    ).resolves.toBe('unreadable');
    await expect(offers()).resolves.toEqual([]);
  });

  it('refuses an occasion the household week already holds', async () => {
    await db.database.insert(schema.familyEvents).values({
      familyId: family.familyId,
      title: '  gymnastics ',
      startsAt: SUNDAY,
      source: 'parent',
      createdBy: family.parentUserId,
    });

    await expect(
      coach({
        title: 'Gymnastics',
        startsAt: SUNDAY,
        channelMessageId: await sentOut(NOW),
      }),
    ).resolves.toBe('already_held');
    await expect(offers()).resolves.toEqual([]);
  });

  it('does not treat one parent Google mirror as the household holding it', async () => {
    const integrationId = await seedIntegration(db.database, family.familyId, family.parentUserId);
    await db.database.insert(schema.familyEvents).values({
      familyId: family.familyId,
      title: 'Gymnastics',
      startsAt: SUNDAY,
      source: 'parent',
      googleEventId: 'gcal-gymnastics',
      integrationId,
    });

    await expect(
      coach({
        title: 'Gymnastics',
        startsAt: SUNDAY,
        channelMessageId: await sentOut(NOW),
      }),
    ).resolves.toBe('recorded');
  });

  it('refuses an occasion already on this parent kid-related calendar', async () => {
    const integrationId = await seedIntegration(db.database, family.familyId, family.parentUserId);
    await db.database.insert(schema.parentCalendarBlocks).values({
      integrationId,
      eventId: 'evt-gymnastics',
      familyId: family.familyId,
      userId: family.parentUserId,
      startAt: SUNDAY,
      kidRelated: true,
      title: 'Gymnastics',
      status: 'confirmed',
      updatedStamp: '1',
    });

    await expect(
      coach({
        title: 'Gymnastics',
        startsAt: SUNDAY,
        channelMessageId: await sentOut(NOW),
      }),
    ).resolves.toBe('already_held');
    await expect(offers()).resolves.toEqual([]);
  });

  it('does not ask a pending add again once that ask has been sent', async () => {
    const actionId = await seedDraftedAction({
      title: TITLE,
      startsAt: STARTS_AT.toISOString(),
      reviewerVerdict: 'pending',
    });
    const minuteOff = new Date(STARTS_AT.getTime() + 60_000);

    expect(
      await findPendingIdenticalCalendarAdd(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        title: TITLE,
        startsAt: minuteOff.toISOString(),
        timeZone: 'America/Toronto',
        now: NOW,
      }),
    ).toBe(actionId);

    const channelMessageId = await sentOut(NOW);
    await expect(coach({ title: TITLE, startsAt: minuteOff, channelMessageId })).resolves.toBe(
      'recorded',
    );

    const questions = await defaultOpenQuestionReader().open(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      now: NOW,
    });
    expect(questions.filter((question) => question.kind === 'approval')).toEqual([]);
    expect(questions.map((question) => question.kind)).toContain('email_alert_add');

    const again = await sentOut(new Date(NOW.getTime() + 60_000));
    await expect(
      coach({ title: TITLE, startsAt: STARTS_AT, channelMessageId: again }),
    ).resolves.toBe('already_asked');
    const open = await loadOpenEmailAlertOffers(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      now: NOW,
    });
    expect(open).toHaveLength(1);
    expect(
      await findPendingIdenticalCalendarAdd(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        title: TITLE,
        startsAt: STARTS_AT.toISOString(),
        timeZone: 'America/Toronto',
        now: NOW,
      }),
    ).toBe(actionId);
  });

  it('does not treat Saturday afternoon as the Saturday morning offer', async () => {
    const morning = new Date('2026-10-10T13:00:00.000Z');
    const afternoon = new Date('2026-10-10T20:00:00.000Z');
    const morningDraft = await seedDraftedAction({
      title: 'Gymnastics',
      startsAt: morning.toISOString(),
      reviewerVerdict: 'pending',
    });
    await seedOffer({ title: 'Gymnastics', startsAt: morning });

    await expect(
      coach({
        title: 'Gymnastics',
        startsAt: afternoon,
        channelMessageId: await sentOut(NOW),
      }),
    ).resolves.toBe('recorded');

    const open = await loadOpenEmailAlertOffers(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      now: NOW,
    });
    expect(open.map((row) => row.startsAt.toISOString())).toEqual([afternoon.toISOString()]);
    const afternoonId = open[0]?.id;
    if (!afternoonId) throw new Error('no afternoon offer');

    const verdict = await reply('yes', { resolved: reading(afternoonId, 'yes') });
    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    const placed = await events();
    expect(placed).toHaveLength(1);
    expect(placed[0]?.startsAt.toISOString()).toBe(afternoon.toISOString());

    const [draft] = await db.database
      .select({ state: schema.actions.userVisibleState })
      .from(schema.actions)
      .where(eq(schema.actions.id, morningDraft));
    expect(draft?.state).toBe('drafted_for_approval');
  });

  it('a NO declines the hidden unapproved add, so the next turn does not list it', async () => {
    const actionId = await seedDraftedAction({
      title: TITLE,
      startsAt: STARTS_AT.toISOString(),
      reviewerVerdict: 'pending',
    });
    const offerId = await seedOffer({ title: TITLE, startsAt: STARTS_AT });

    const open = async () =>
      defaultOpenQuestionReader().open(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        now: NOW,
      });
    const first = await open();
    const offer = first.find((question) => question.id === offerId);
    expect(offer?.declinesActionId).toBe(actionId);
    expect(offer?.approvesActionId).toBeUndefined();
    expect(first.filter((question) => question.kind === 'approval')).toEqual([]);

    const verdict = await reply('no', { resolved: reading(offerId, 'no') });
    expect(verdict).toMatchObject({ claimed: true, outcome: 'declined' });
    if (!verdict.claimed) throw new Error('unreachable');
    await declineDraftedAction(db.database, {
      actionId,
      familyId: family.familyId,
      declinedBy: family.parentUserId,
    });
    await verdict.afterSend?.(await receipt());

    const next = await open();
    expect(next.filter((question) => question.kind === 'approval')).toEqual([]);
    expect(next.find((question) => question.id === offerId)).toBeUndefined();
  });

  it('a private offer does not stop a group ask from drafting', async () => {
    await seedOffer({ title: TITLE, startsAt: STARTS_AT });
    const asked = {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      title: TITLE,
      startsAt: STARTS_AT.toISOString(),
      timeZone: 'America/Toronto',
      now: NOW,
      audience: 'group' as const,
      groupChatId: 'chat-family',
    };
    expect(await findPendingIdenticalCalendarAdd(db.database, asked)).toBeNull();
    expect(
      await findPendingIdenticalCalendarAdd(db.database, { ...asked, audience: 'direct' }),
    ).toEqual(expect.any(String));

    const record = vi.fn(async () => 'recorded' as const);
    const port = groupPlanDraftPort(
      {
        pendingIdentical: (input) => findPendingIdenticalCalendarAdd(db.database, input),
        draft: async () => ({ actionId: 'group-add' }),
      },
      { audience: 'group', conversationId: 'c-group', groupChatId: 'chat-family' },
      record,
    );
    expect(await port.pendingIdentical?.(asked)).toBeNull();
    await expect(
      port.draft({
        familyId: family.familyId,
        actor: family.parentUserId,
        actionType: 'calendar_add',
        payload: { title: TITLE, startsAt: STARTS_AT.toISOString() },
        rationale: 'the group asked',
        teenContent: false,
      }),
    ).resolves.toEqual({ actionId: 'group-add' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'group-add', conversationId: 'c-group' }),
    );
  });

  it('records a future offer, expires the older one, and stops at the start', async () => {
    const older = await seedOffer();
    const channelMessageId = await sentOut(NOW);

    await expect(coach({ title: 'Gymnastics', startsAt: SUNDAY, channelMessageId })).resolves.toBe(
      'recorded',
    );

    const rows = await offers();
    expect(rows.find((row) => row.id === older)?.expiresAt.toISOString()).toBe(NOW.toISOString());
    const created = rows.find((row) => row.id !== older);
    expect(created).toMatchObject({
      title: 'Gymnastics',
      integrationId: COACH_CALENDAR_INTEGRATION_ID,
      messageId: `coach:${channelMessageId}`,
      resolution: null,
    });
    expect(created?.startsAt.toISOString()).toBe(SUNDAY.toISOString());
    expect(created?.expiresAt.toISOString()).toBe(
      new Date(Math.min(NOW.getTime() + EMAIL_ALERT_OFFER_TTL_MS, SUNDAY.getTime())).toISOString(),
    );
  });

  it('a bare yes on Oct 2 does not add the Thursday gymnastics that already started', async () => {
    // VIL-410. The Thursday offer is still inside a flat day, which is how a bare yes
    // placed Gymnastics Thu Oct 1 4:15pm. It is not an open offer on Oct 2, and a bare
    // yes has no reading to bind.
    await seedOffer({
      title: 'Gymnastics',
      startsAt: THURSDAY,
      expiresAt: new Date(OCTOBER_SECOND.getTime() + EMAIL_ALERT_OFFER_TTL_MS),
    });
    const sundayId = await seedOffer({
      title: 'Gymnastics',
      startsAt: SUNDAY,
      expiresAt: new Date(OCTOBER_SECOND.getTime() + EMAIL_ALERT_OFFER_TTL_MS),
    });

    const open = await loadOpenEmailAlertOffers(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      now: OCTOBER_SECOND,
    });
    expect(open.map((offer) => offer.id)).toEqual([sundayId]);

    const ctx = await turn('yes');
    const verdict = await handler().handle(db.database, { ...ctx, now: OCTOBER_SECOND });

    expect(verdict).toEqual({ claimed: false });
    await expect(events()).resolves.toEqual([]);
  });

  it('places the Sunday the reading named, not the Thursday that already started', async () => {
    await seedOffer({
      title: 'Gymnastics',
      startsAt: THURSDAY,
      expiresAt: new Date(OCTOBER_SECOND.getTime() + EMAIL_ALERT_OFFER_TTL_MS),
    });
    const sundayId = await seedOffer({
      title: 'Gymnastics',
      startsAt: SUNDAY,
      expiresAt: new Date(OCTOBER_SECOND.getTime() + EMAIL_ALERT_OFFER_TTL_MS),
    });

    const open = await loadOpenEmailAlertOffers(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      now: OCTOBER_SECOND,
    });
    expect(open.map((offer) => offer.id)).toEqual([sundayId]);

    const ctx = await turn('好的，就周日的体操', { resolved: reading(sundayId, 'yes') });
    const verdict = await handler().handle(db.database, { ...ctx, now: OCTOBER_SECOND });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.startsAt.toISOString()).toBe(SUNDAY.toISOString());
  });
});
