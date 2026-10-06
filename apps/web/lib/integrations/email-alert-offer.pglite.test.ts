import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailAlertAddHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext, HandlerVerdict, ResolvedAnswer } from '~/lib/channel/router/route';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { defaultReminderRunDeps, runReminderCron } from '~/lib/loop/reminders/run';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  EMAIL_ALERT_EVENT_DURATION_MS,
  EMAIL_ALERT_OFFER_TTL_MS,
  prepareCoachCalendarReply,
  recordCoachEventOffer,
  recordEmailAlertOffer,
} from './email-alert-offer';
import type { OfferReceiptFacts, OfferReceiptPorts } from './offer-receipt';

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

const spoken: OfferReceiptFacts[] = [];
const paged: string[] = [];

/** A port that writes a line from the facts. Not a model, and not a template
 * the product sends — the product sends whatever the offer-receipt skill writes
 * once the verifier accepts it. */
function receiptPorts(attempt?: OfferReceiptPorts['attempt']): OfferReceiptPorts {
  return {
    attempt:
      attempt ??
      (async (facts) => {
        spoken.push(facts);
        return `Noted ${facts.title} on ${facts.whenLabel}`;
      }),
    alert: async (text) => {
      paged.push(text);
    },
  };
}

function handler(ports: OfferReceiptPorts = receiptPorts()) {
  return emailAlertAddHandler(ports);
}

beforeEach(async () => {
  family = await seedFamily(db.database);
  spoken.length = 0;
  paged.length = 0;
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
  over: { resolved?: ResolvedAnswer; open?: 'real' | 'none'; now?: Date } = {},
): Promise<HandlerContext> {
  const now = over.now ?? NOW;
  const open =
    over.open === 'none'
      ? []
      : await defaultOpenQuestionReader().open(db.database, {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          now,
        });
  return {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    conversationId: randomUUID(),
    body,
    send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' as const }),
    now,
    resolved: over.resolved ?? null,
    openQuestions: async () => open,
    inboundChannelMessageId: randomUUID(),
  };
}

function reply(body: string, over?: Parameters<typeof turn>[1]): Promise<HandlerVerdict> {
  return turn(body, over).then((ctx) => handler().handle(db.database, ctx));
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
    expect(spoken.at(-1)).toMatchObject({ kind: 'added', title: TITLE });
    expect(spoken.at(-1)?.whenLabel).toBe('Saturday, Sep 19 at 9:00 a.m.');
    expect(verdict.reply).toBe(`Noted ${TITLE} on ${spoken.at(-1)?.whenLabel}`);

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
    await seedOffer({ integrationId, messageId, kind: 'booking_confirmation', channelMessageId });
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

    await expect(reply('yes')).resolves.toMatchObject({ claimed: true, outcome: 'added' });

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
    await seedOffer({ integrationId, messageId, kind: 'booking_confirmation', channelMessageId });
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

    await expect(reply('no')).resolves.toMatchObject({ claimed: true, outcome: 'declined' });

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
    await seedOffer({ kind: 'booking_confirmation' });

    await expect(reply('yes')).resolves.toMatchObject({ claimed: true, outcome: 'added' });

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
    await seedOffer();

    await expect(reply('yes')).resolves.toMatchObject({ claimed: true, outcome: 'added' });

    expect(logged).not.toHaveBeenCalled();
  });

  it('closes the offer only once the receipt has actually gone', async () => {
    // The MEM-10 discipline. A turn that placed the event and then failed to answer must
    // leave the question standing, so the redrive finds it.
    await seedOffer();

    const verdict = await reply('yes');
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
    expect(spoken.at(-1)).toMatchObject({
      kind: 'declined',
      title: TITLE,
      whenLabel: 'Saturday, Sep 19 at 9:00 a.m.',
    });
    expect(verdict.reply).toBe(`Noted ${TITLE} on Saturday, Sep 19 at 9:00 a.m.`);
    await expect(events()).resolves.toHaveLength(0);

    await verdict.afterSend?.(await receipt());
    await expect(offers()).resolves.toMatchObject([{ resolution: 'declined', eventId: null }]);
  });

  it('answers a SECOND yes with what is already there, and adds nothing', async () => {
    const offerId = await seedOffer();
    const first = await reply('yes');
    if (!first.claimed) throw new Error('unreachable');
    await first.afterSend?.(await receipt());

    // The offer is closed now, so nothing is listed and `soleOpenKind` is vacuously true
    // — which is exactly why the repeat branch has to find a row of its own.
    const repeat = await reply('yes');

    expect(repeat).toMatchObject({ claimed: true, outcome: 'already_added' });
    if (!repeat.claimed) throw new Error('unreachable');
    expect(spoken.at(-1)?.kind).toBe('already_added');
    expect(repeat.reply).toBe(`Noted ${TITLE} on Saturday, Sep 19 at 9:00 a.m.`);
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
    await first.afterSend?.(await receipt());

    const late = await turn('yes');
    const verdict = await handler().handle(db.database, {
      ...late,
      now: new Date(NOW.getTime() + 11 * 60 * 1000),
    });

    expect(verdict).toEqual({ claimed: false });
  });

  it('lets the word go to the coach once Hale has said something else', async () => {
    // The SECOND bound on the repeat branch, and the one the window alone cannot give: a
    // bare affirmative belongs to Hale's LAST word (the registration ladder's own rule).
    // Two minutes after the receipt, with one unrelated text in between, "yes" is an
    // answer to THAT — a coach question asked in the window must not lose its answer to a
    // second copy of a receipt the parent already has.
    await seedOffer();
    const first = await reply('yes');
    if (!first.claimed) throw new Error('unreachable');
    await first.afterSend?.(await receipt());
    await sentOut(new Date(NOW.getTime() + 60 * 1000));

    const ctx = await turn('yes');
    const verdict = await handler().handle(db.database, {
      ...ctx,
      now: new Date(NOW.getTime() + 2 * 60 * 1000),
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

/**
 * VIL-410, the 2026-10-02 iMessage. Hale had offered Thursday Oct 1 gymnastics,
 * the parent said it was yesterday, and Hale then named Sunday Oct 4 at 9am.
 * A later yes added the past Thursday. The past row must not be answerable,
 * and the yes must place Sunday.
 *
 * Times are America/Toronto (EDT, UTC-4). now is 2:00 p.m. on Friday Oct 2.
 */
describe('VIL-410 the Oct 2 transcript', () => {
  const OCT2 = new Date('2026-10-02T18:00:00.000Z');
  const THU_OCT1 = new Date('2026-10-01T20:15:00.000Z');
  const SUN_OCT4 = new Date('2026-10-04T13:00:00.000Z');
  const SUNDAY_ASK =
    'That one passed. Gymnastics is on Sunday, Oct 4 at 9:00 a.m. Want me to add it?';

  async function seedPastThursday(): Promise<void> {
    await seedOffer({
      title: 'Gymnastics',
      startsAt: THU_OCT1,
      location: null,
      expiresAt: new Date(OCT2.getTime() + EMAIL_ALERT_OFFER_TTL_MS),
    });
  }

  async function offerSunday(): Promise<string> {
    const prepared = await prepareCoachCalendarReply(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      body: SUNDAY_ASK,
      now: OCT2,
    });
    expect(prepared).toMatchObject({ outcome: 'offer', body: SUNDAY_ASK });
    if (prepared.outcome !== 'offer') throw new Error('unreachable');
    expect(prepared.offer.startsAt.toISOString()).toBe(SUN_OCT4.toISOString());
    expect(prepared.offer.title).toBe('Gymnastics');
    const channelMessageId = await sentOut(OCT2);
    await expect(
      recordCoachEventOffer(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channelMessageId,
        draft: prepared.offer,
        now: OCT2,
      }),
    ).resolves.toBe('recorded');
    return channelMessageId;
  }

  it('declines the past Thursday, then a natural yes adds Sunday Oct 4', async () => {
    await seedPastThursday();

    const correction = await reply("It's yesterday", { now: OCT2 });
    expect(correction).toMatchObject({ claimed: false });
    const barePast = await reply('YES', { now: OCT2 });
    expect(barePast).toMatchObject({ claimed: false });
    await expect(events()).resolves.toEqual([]);

    const channelMessageId = await offerSunday();
    const standing = await offers();
    const thursday = standing.find((row) => row.startsAt.toISOString() === THU_OCT1.toISOString());
    const sunday = standing.find((row) => row.startsAt.toISOString() === SUN_OCT4.toISOString());
    expect(thursday?.expiresAt.getTime()).toBeLessThanOrEqual(OCT2.getTime());
    expect(sunday?.expiresAt.getTime()).toBeGreaterThan(OCT2.getTime());

    await expect(
      recordCoachEventOffer(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channelMessageId,
        draft: {
          kind: 'new_event',
          title: 'Gymnastics',
          startsAt: SUN_OCT4,
          location: null,
        },
        now: OCT2,
      }),
    ).resolves.toBe('already_recorded');
    const redriven = await offers();
    expect(
      redriven
        .find((row) => row.startsAt.toISOString() === SUN_OCT4.toISOString())
        ?.expiresAt.getTime(),
    ).toBeGreaterThan(OCT2.getTime());

    const verdict = await reply('sounds good', { now: OCT2 });
    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    if (!verdict.claimed) throw new Error('unreachable');
    expect(spoken.at(-1)).toMatchObject({ kind: 'added', title: 'Gymnastics' });
    expect(spoken.at(-1)?.whenLabel).toContain('Sunday, Oct 4');
    expect(spoken.at(-1)?.whenLabel).not.toContain('Oct 1');
    expect(verdict.reply).toContain('Sunday, Oct 4');
    expect(verdict.reply).toContain('9:00 a.m.');
    expect(verdict.reply).not.toContain('Oct 1');

    const placed = await events();
    expect(placed).toHaveLength(1);
    expect(placed[0]?.title).toBe('Gymnastics');
    expect(placed[0]?.startsAt.toISOString()).toBe(SUN_OCT4.toISOString());
  });

  it.each(['yep do it', 'ok', 'perfect', 'oui vas-y', 'YES'])(
    'places Sunday for %s and never Thursday',
    async (phrase) => {
      await seedPastThursday();
      await offerSunday();

      const verdict = await reply(phrase, { now: OCT2 });
      expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
      if (!verdict.claimed) throw new Error('unreachable');
      expect(verdict.reply).not.toContain('Oct 1');
      const placed = await events();
      expect(placed).toHaveLength(1);
      expect(placed[0]?.startsAt.toISOString()).toBe(SUN_OCT4.toISOString());
    },
  );

  it('a resolver yes that names Sunday still places Sunday', async () => {
    await seedPastThursday();
    await offerSunday();
    const sunday = (await offers()).find(
      (row) => row.startsAt.toISOString() === SUN_OCT4.toISOString(),
    );
    if (!sunday) throw new Error('no sunday offer');

    const verdict = await reply('yeah the sunday one', {
      now: OCT2,
      resolved: {
        kind: 'email_alert_add',
        questionId: sunday.id,
        polarity: 'yes',
        confidence: 'high',
      },
    });

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });
    const placed = await events();
    expect(placed).toHaveLength(1);
    expect(placed[0]?.startsAt.toISOString()).toBe(SUN_OCT4.toISOString());
  });

  it('treats a correction of a still-future offer as a decline', async () => {
    await seedOffer();

    for (const phrase of ["It's yesterday", 'not that one', 'no']) {
      const verdict = await reply(phrase);
      expect(verdict, phrase).toMatchObject({ claimed: true, outcome: 'declined' });
      if (!verdict.claimed) throw new Error('unreachable');
      expect(verdict.reply).toBe(`Noted ${TITLE} on Saturday, Sep 19 at 9:00 a.m.`);
      expect(spoken.at(-1)?.kind).toBe('declined');
    }
    await expect(events()).resolves.toEqual([]);
  });

  it('does not guess when two offers are open', async () => {
    await seedOffer({ title: 'Swim class' });
    await seedOffer({ title: 'Picture day' });

    expect(await reply('YES')).toMatchObject({ claimed: false });
    expect(await reply("It's yesterday")).toMatchObject({ claimed: false });
    await expect(events()).resolves.toEqual([]);
  });

  it('refuses to record an offer whose start has passed, and caps one inside a day', async () => {
    const past = await recordEmailAlertOffer(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: randomUUID(),
      messageId: randomUUID(),
      channelMessageId: await sentAlert(),
      draft: {
        kind: 'new_event',
        title: 'Gymnastics',
        startsAt: THU_OCT1,
        location: null,
      },
      now: OCT2,
    });
    expect(past).toBe('event_started');
    await expect(offers()).resolves.toEqual([]);

    const soon = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    const recorded = await recordEmailAlertOffer(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: randomUUID(),
      messageId: randomUUID(),
      channelMessageId: await sentAlert(),
      draft: { kind: 'new_event', title: 'Swim class', startsAt: soon, location: null },
      now: NOW,
    });
    expect(recorded).toBe('recorded');
    const [row] = await offers();
    expect(row?.expiresAt.toISOString()).toBe(soon.toISOString());
  });

  it('does not turn a move, a past ask, or an already-held ask into an offer', async () => {
    const move = await prepareCoachCalendarReply(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      body: 'Want me to move swim to Tue 4:30?',
      now: OCT2,
    });
    expect(move).toMatchObject({ outcome: 'not_an_offer', offer: null });

    const pastAsk = await prepareCoachCalendarReply(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      body: 'Gymnastics is on Thursday, Oct 1 at 4:15 p.m. Want me to add it?',
      now: OCT2,
    });
    expect(pastAsk).toMatchObject({ outcome: 'past', offer: null });
    expect(pastAsk.body).toContain('Thursday, Oct 1');

    await db.database.insert(schema.familyEvents).values({
      familyId: family.familyId,
      title: 'Gymnastics',
      startsAt: SUN_OCT4,
      source: 'parent',
      createdBy: family.parentUserId,
    });
    const held = await prepareCoachCalendarReply(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      body: SUNDAY_ASK,
      now: OCT2,
    });
    expect(held).toMatchObject({ outcome: 'already_on_calendar', offer: null, body: SUNDAY_ASK });
    await expect(offers()).resolves.toEqual([]);
    await expect(events()).resolves.toHaveLength(1);
  });

  it('sends nothing and pages ops when the receipt cannot name the occasion', async () => {
    await seedOffer();
    const verdict = await handler(receiptPorts(async () => 'Okay - left it off.')).handle(
      db.database,
      await turn('yes'),
    );

    expect(verdict).toMatchObject({ claimed: true, outcome: 'added', reply: null });
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.afterSend).toBeUndefined();
    expect(paged).toHaveLength(1);
    expect(paged[0]).toContain('unsent after retry');
    await expect(events()).resolves.toHaveLength(1);
    await expect(offers()).resolves.toMatchObject([{ resolvedAt: null, resolution: null }]);
  });

  it('follows an add tool even when the sentence reads as a move', async () => {
    const prepared = await prepareCoachCalendarReply(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      body: 'Want me to move swim to Tue 4:30?',
      now: OCT2,
      intents: [{ verb: 'add', title: 'Gymnastics', startsAt: SUN_OCT4 }],
    });
    expect(prepared.outcome).toBe('offer');
    if (prepared.outcome !== 'offer') throw new Error('unreachable');
    expect(prepared.offer).toMatchObject({ title: 'Gymnastics', startsAt: SUN_OCT4 });
  });

  it('writes no offer row when the tool said move, even if the sentence says add', async () => {
    const prepared = await prepareCoachCalendarReply(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      body: SUNDAY_ASK,
      now: OCT2,
      intents: [{ verb: 'move', title: 'Swim lesson', startsAt: SUN_OCT4 }],
    });
    expect(prepared).toMatchObject({ outcome: 'not_an_offer', offer: null });
  });
});
