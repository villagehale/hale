import { schema } from '@hale/db';
import { and, eq, gt } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  auditSmokeAlarmClaim,
  auditTurnLedger,
  defaultHandlers,
  defaultOpenQuestionReader,
  loadInboundContext,
} from '~/lib/channel/router/wiring';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { createDisambiguationStore } from '~/lib/channel/router/disambiguation';
import { FakeReplyTransport } from '~/lib/channel/router/reply-route';
import { encryptString } from '~/lib/crypto/string-cipher';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { ChannelRouterDeps, HandlerContext } from '~/lib/channel/router/route';
import { routeChannelMessage } from '~/lib/channel/router/route';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { nightlyOccasion } from '~/lib/channel/variant';
import {
  CHECK_IN_ACK_TEMPLATE_KEY,
  CHECK_IN_ASK_TEMPLATE_KEY,
  CHECK_IN_DAILY_ACK,
  checkInNotedAck,
  CHECK_IN_NOT_KEPT_ACK,
  CHECK_IN_OFF_ACK,
  CHECK_IN_STEP_DOWN_TEMPLATE_KEY,
  CHECK_IN_WEEKLY_ACK,
} from './copy';
import { NOTE_RETENTION_DAYS, purgeExpiredCheckInNotes } from './notes';
import { CHECK_IN_REOFFER_DAYS, eveningCheckInQuestion, handleEveningCheckInReply } from './reply';

/**
 * The evening answer, against real Postgres and through the PRODUCTION reader.
 *
 * The open question behind this lane has no row and no column — it is derived from the
 * message ledger — so a test that injected the source would be testing a stipulation.
 * `defaultOpenQuestionReader()` is what the router actually calls, and this file is the
 * only pin on that wiring.
 */

/** 20:17 Toronto on Sunday 2026-07-05, the instant the question went out. */
const ASKED_AT = new Date('2026-07-06T00:17:00.000Z');
/** 21:40 the same local evening — a parent answering from the couch. */
const ANSWERED_AT = new Date('2026-07-06T01:40:00.000Z');
const TZ = 'America/Toronto';

/**
 * The thank-you THIS household reads on THIS evening. The ack is pooled (five per
 * language, rotating once per family-local day — variant.ts), so the expected string is a
 * function of the seeded family's id and the clock rather than a constant. Computed
 * through the production selector, so a test cannot quietly disagree with the lane about
 * which member tonight is.
 */
function notedAck(familyId: string, now: Date, language: 'en' | 'fr' = 'en'): string {
  return checkInNotedAck(language, familyId, nightlyOccasion(now, TZ));
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

interface Seeded {
  familyId: string;
  parentUserId: string;
}

async function seedFamily(): Promise<Seeded> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:evening', name: 'Ana', timezone: TZ })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  return { familyId, parentUserId };
}

async function seedAsk(
  seeded: Seeded,
  overrides: { templateKey?: string; createdAt?: Date; status?: 'queued' | 'failed' } = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'evening_check_in',
      templateKey: overrides.templateKey ?? CHECK_IN_ASK_TEMPLATE_KEY,
      status: overrides.status ?? 'queued',
      createdAt: overrides.createdAt ?? ASKED_AT,
    })
    .returning({ id: schema.channelMessages.id });
  return row?.id as string;
}

async function seedInbound(
  seeded: Seeded,
  body: string,
  channel: 'sms' | 'email' = 'sms',
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel,
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body,
      createdAt: ANSWERED_AT,
    })
    .returning({ id: schema.channelMessages.id });
  return row?.id as string;
}

function openQuestions(seeded: Seeded, now: Date) {
  return defaultOpenQuestionReader().open(db.database, { ...seeded, now });
}

async function readPrefs(familyId: string) {
  const [row] = await db.database
    .select()
    .from(schema.familyCheckInPrefs)
    .where(eq(schema.familyCheckInPrefs.familyId, familyId));
  return row;
}

async function readNotes(familyId: string) {
  return db.database
    .select()
    .from(schema.familyCheckInNotes)
    .where(eq(schema.familyCheckInNotes.familyId, familyId));
}

async function readAudit(familyId: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
}

describe('the standing question, read the way the router reads it', () => {
  it('is open for the rest of the evening and named without a child in it', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const questions = await openQuestions(seeded, ANSWERED_AT);
    expect(
      questions.map((q) => ({
        kind: q.kind,
        askedAt: q.askedAt,
        solicited: q.solicited,
        answerable: q.answerable,
      })),
    ).toEqual([
      {
        kind: 'evening_check_in',
        askedAt: ASKED_AT,
        // FALSE, or a bare YES meant for an approval would be claimed by a diary entry
        // on every evening this question is the newest one.
        solicited: false,
        answerable: { yes: false, no: false },
      },
    ]);
    expect(questions[0]?.subject).not.toMatch(/Mia|Leo/);
  });

  it('closes the moment anything else goes out to that parent', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'queued',
      createdAt: new Date(ASKED_AT.getTime() + 60_000),
    });
    expect(await openQuestions(seeded, ANSWERED_AT)).toEqual([]);
  });

  it('lapses at 08:00 the next local morning, so a morning text is a new conversation', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    // 07:55 local — still last night's question.
    expect(await openQuestions(seeded, new Date('2026-07-06T11:55:00.000Z'))).toHaveLength(1);
    // 08:05 local.
    expect(await openQuestions(seeded, new Date('2026-07-06T12:05:00.000Z'))).toEqual([]);
  });

  it('is not opened by the step-down notice, which asks nothing', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded, { templateKey: CHECK_IN_STEP_DOWN_TEMPLATE_KEY });
    expect(await openQuestions(seeded, ANSWERED_AT)).toEqual([]);
  });

  it('is never opened for a parent the question did not go to', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const [other] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:coparent', name: 'Sam', timezone: TZ })
      .returning({ id: schema.users.id });
    const coParentId = other?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: seeded.familyId, userId: coParentId, role: 'co_parent' });
    expect(
      await eveningCheckInQuestion(db.database, {
        familyId: seeded.familyId,
        parentUserId: coParentId,
        now: ANSWERED_AT,
      }),
    ).toBeNull();
  });
});

describe('the three words that move the cadence', () => {
  it('moves to weekly, off and back to nightly, and never writes a note doing it', async () => {
    for (const [body, cadence, ack] of [
      ['LESS', 'weekly', CHECK_IN_WEEKLY_ACK.en],
      ['no', 'off', CHECK_IN_OFF_ACK.en],
      ['Daily.', 'daily', CHECK_IN_DAILY_ACK.en],
    ] as const) {
      const seeded = await seedFamily();
      const inbound = await seedInbound(seeded, body);
      const outcome = await handleEveningCheckInReply(db.database, {
        ...seeded,
        body,
        askedAt: ASKED_AT,
        timeZone: TZ,
        inboundChannelMessageId: inbound,
        now: ANSWERED_AT,
      });

      expect(outcome, body).toEqual({ status: `cadence_${cadence}`, reply: ack });
      const prefs = await readPrefs(seeded.familyId);
      expect(prefs?.cadence, body).toBe(cadence);
      expect(prefs?.lastAnsweredAt, body).toEqual(ANSWERED_AT);
      expect(await readNotes(seeded.familyId), body).toEqual([]);
      const audit = await readAudit(seeded.familyId);
      expect(audit.map((row) => row.actionTaken), body).toEqual([
        'evening_check_in_cadence_changed',
      ]);
      await db.exec('truncate table families, users cascade');
    }
  });

  it('answers a French parent in French', async () => {
    const seeded = await seedFamily();
    const inbound = await seedInbound(seeded, 'non merci');
    const outcome = await handleEveningCheckInReply(db.database, {
      ...seeded,
      // 'non merci' is not the bare keyword, so it is a SENTENCE — the point here is only
      // that the language of the reply follows the parent's own words.
      body: 'non',
      askedAt: ASKED_AT,
      timeZone: TZ,
      inboundChannelMessageId: inbound,
      now: ANSWERED_AT,
    });
    expect(outcome).toEqual({ status: 'cadence_off', reply: CHECK_IN_OFF_ACK.fr });
  });
});

describe('what the parent said about their day', () => {
  it('keeps it for thirty days, under the day it was about, with nothing in the audit row', async () => {
    const seeded = await seedFamily();
    const body = 'Park after daycare and both asleep by 7. Rare win.';
    const inbound = await seedInbound(seeded, body);

    const outcome = await handleEveningCheckInReply(db.database, {
      ...seeded,
      body,
      askedAt: ASKED_AT,
      timeZone: TZ,
      inboundChannelMessageId: inbound,
      now: ANSWERED_AT,
    });
    expect(outcome).toEqual({
      status: 'note_stored',
      reply: notedAck(seeded.familyId, ANSWERED_AT),
    });

    const notes = await readNotes(seeded.familyId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toBe(body);
    expect(notes[0]?.sourceMessageId).toBe(inbound);
    // The local day the question was ABOUT, not the UTC day the answer arrived on.
    expect(notes[0]?.notedOn).toBe('2026-07-05');
    expect(notes[0]?.expiresAt).toEqual(
      new Date(ANSWERED_AT.getTime() + NOTE_RETENTION_DAYS * 24 * 3_600_000),
    );

    const prefs = await readPrefs(seeded.familyId);
    expect(prefs?.silentStreak).toBe(0);
    expect(prefs?.lastAnsweredAt).toEqual(ANSWERED_AT);

    const audit = await readAudit(seeded.familyId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actionTaken).toBe('evening_check_in_answered');
    expect(audit[0]?.after).toEqual({ stored: true });
    expect(JSON.stringify(audit[0])).not.toContain('daycare');
  });

  it('keeps nothing at all when the sentence is one of the categories Hale does not hold', async () => {
    const seeded = await seedFamily();
    const body = 'Mia had a fever all afternoon, up half the night';
    const inbound = await seedInbound(seeded, body);

    const outcome = await handleEveningCheckInReply(db.database, {
      ...seeded,
      body,
      askedAt: ASKED_AT,
      timeZone: TZ,
      inboundChannelMessageId: inbound,
      now: ANSWERED_AT,
    });
    expect(outcome).toEqual({ status: 'not_stored_sensitive', reply: CHECK_IN_NOT_KEPT_ACK.en });
    expect(await readNotes(seeded.familyId)).toEqual([]);
    // The answer still counts as an answer: the ladder must not punish a parent for
    // telling Hale something it chose not to keep.
    expect((await readPrefs(seeded.familyId))?.lastAnsweredAt).toEqual(ANSWERED_AT);
    const audit = await readAudit(seeded.familyId);
    expect(audit[0]?.after).toEqual({ stored: false });
  });

  it('corrects itself rather than writing a second evening', async () => {
    const seeded = await seedFamily();
    const first = await seedInbound(seeded, 'ok day');
    const input = {
      ...seeded,
      askedAt: ASKED_AT,
      timeZone: TZ,
      inboundChannelMessageId: first,
      now: ANSWERED_AT,
    };
    await handleEveningCheckInReply(db.database, { ...input, body: 'ok day' });
    await handleEveningCheckInReply(db.database, {
      ...input,
      body: 'actually a great day',
      now: new Date(ANSWERED_AT.getTime() + 120_000),
    });
    const notes = await readNotes(seeded.familyId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toBe('actually a great day');
  });

  it('hands a question back to the coach instead of filing it as a diary entry', async () => {
    const seeded = await seedFamily();
    const body = 'Fine - can you find a swim class on Saturdays?';
    const inbound = await seedInbound(seeded, body);
    const outcome = await handleEveningCheckInReply(db.database, {
      ...seeded,
      body,
      askedAt: ASKED_AT,
      timeZone: TZ,
      inboundChannelMessageId: inbound,
      now: ANSWERED_AT,
    });
    expect(outcome).toEqual({ status: 'declined_to_claim' });
    expect(await readNotes(seeded.familyId)).toEqual([]);
    expect(await readAudit(seeded.familyId)).toEqual([]);
  });
});

describe('the handler in the chain', () => {
  const approval: OpenQuestion = {
    id: 'action-1',
    kind: 'approval',
    description: 'Add to your calendar',
    subject: 'add to your calendar',
    answerable: { yes: true, no: true },
    askedAt: null,
    solicited: false,
  };

  /** The standing question as the reader builds it, around a REAL ask row — the handler
   * now reads that row back to check the answer came through the same door. */
  function evening(askId: string): OpenQuestion {
    return {
      id: askId,
      kind: 'evening_check_in',
      description: 'How the day went at home',
      subject: 'how today went',
      answerable: { yes: false, no: false },
      askedAt: ASKED_AT,
      solicited: false,
    };
  }

  function handler() {
    const found = defaultHandlers().find((each) => each.name === 'evening_check_in');
    if (!found) throw new Error('the evening check-in handler is not in the chain');
    return found;
  }

  function turn(seeded: Seeded, body: string, open: OpenQuestion[], inbound: string | null) {
    return {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      conversationId: null,
      body,
      send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' as const }),
      now: ANSWERED_AT,
      resolved: null,
      openQuestions: async () => open,
      inboundChannelMessageId: inbound,
    } as unknown as HandlerContext;
  }

  it('claims a sentence only while Hale is holding the question', async () => {
    const seeded = await seedFamily();
    const askId = await seedAsk(seeded);
    const inbound = await seedInbound(seeded, 'quiet one');
    expect(await handler().handle(db.database, turn(seeded, 'quiet one', [], inbound))).toEqual({
      claimed: false,
    });
    expect(await readNotes(seeded.familyId)).toEqual([]);

    const verdict = await handler().handle(
      db.database,
      turn(seeded, 'quiet one', [evening(askId)], inbound),
    );
    expect(verdict).toEqual({
      claimed: true,
      outcome: 'note_stored',
      reply: notedAck(seeded.familyId, ANSWERED_AT),
      templateKey: CHECK_IN_ACK_TEMPLATE_KEY,
    });
  });

  it('hands a request back to the coach rather than filing it as a diary entry', async () => {
    const seeded = await seedFamily();
    const askId = await seedAsk(seeded);
    const body = 'add swim to the calendar saturday 10am';
    const inbound = await seedInbound(seeded, body);
    expect(
      await handler().handle(db.database, turn(seeded, body, [evening(askId)], inbound)),
    ).toEqual({ claimed: false });
    expect(await readNotes(seeded.familyId)).toEqual([]);
  });

  it('hands back a two-word question whose only marker is the question mark', async () => {
    const seeded = await seedFamily();
    const askId = await seedAsk(seeded);
    const body = 'Swim tomorrow?';
    const inbound = await seedInbound(seeded, body);
    expect(
      await handler().handle(db.database, turn(seeded, body, [evening(askId)], inbound)),
    ).toEqual({ claimed: false });
    expect(await readNotes(seeded.familyId)).toEqual([]);
  });

  it('does not answer a text question with an email, or file the email as a day note', async () => {
    const seeded = await seedFamily();
    const askId = await seedAsk(seeded);
    const body = 'Forwarding the school newsletter for the calendar';
    const inbound = await seedInbound(seeded, body, 'email');
    expect(
      await handler().handle(db.database, turn(seeded, body, [evening(askId)], inbound)),
    ).toEqual({ claimed: false });
    expect(await readNotes(seeded.familyId)).toEqual([]);
  });

  it('does not steal a bare NO that an open approval could have meant', async () => {
    const seeded = await seedFamily();
    const askId = await seedAsk(seeded);
    const inbound = await seedInbound(seeded, 'no');
    expect(
      await handler().handle(db.database, turn(seeded, 'no', [evening(askId), approval], inbound)),
    ).toEqual({ claimed: false });
    expect((await readPrefs(seeded.familyId))?.cadence).toBeUndefined();
  });

  it('declines a spoken turn rather than inventing provenance for the note', async () => {
    const seeded = await seedFamily();
    const askId = await seedAsk(seeded);
    expect(
      await handler().handle(db.database, turn(seeded, 'lovely day', [evening(askId)], null)),
    ).toEqual({ claimed: false });
    expect(await readNotes(seeded.familyId)).toEqual([]);
  });
});

/**
 * The words every message in this lane prints have to work after the question has closed,
 * and Hale's own thank-you is what closes it. These are the moments a parent actually
 * reaches for the keyword — and the ones where the word belongs to somebody else.
 */
describe('LESS, NO and DAILY after the question has closed', () => {
  function handler() {
    const found = defaultHandlers().find((each) => each.name === 'evening_check_in');
    if (!found) throw new Error('the evening check-in handler is not in the chain');
    return found;
  }

  function turn(seeded: Seeded, body: string, open: OpenQuestion[], inbound: string, now: Date) {
    return {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      conversationId: null,
      body,
      send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' as const }),
      now,
      resolved: null,
      openQuestions: async () => open,
      inboundChannelMessageId: inbound,
    } as unknown as HandlerContext;
  }

  it('drops the evening check-ins for good when NO arrives after Hale\'s own thank-you', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    // The ack Hale sent back closes the standing question — this is the state the router
    // is in one minute later.
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'queued',
      createdAt: new Date(ASKED_AT.getTime() + 61_000),
    });
    expect(await openQuestions(seeded, ANSWERED_AT)).toEqual([]);

    const inbound = await seedInbound(seeded, 'NO');
    expect(
      await handler().handle(db.database, turn(seeded, 'NO', [], inbound, ANSWERED_AT)),
    ).toEqual({
      claimed: true,
      outcome: 'cadence_off',
      reply: CHECK_IN_OFF_ACK.en,
      templateKey: CHECK_IN_ACK_TEMPLATE_KEY,
    });
    expect((await readPrefs(seeded.familyId))?.cadence).toBe('off');
  });

  it('switches back to nightly when DAILY arrives after the weekly notice', async () => {
    const seeded = await seedFamily();
    // The step-down notice is the message that teaches DAILY, and it opens no question.
    await seedAsk(seeded, { templateKey: CHECK_IN_STEP_DOWN_TEMPLATE_KEY });
    expect(await openQuestions(seeded, ANSWERED_AT)).toEqual([]);

    const inbound = await seedInbound(seeded, 'DAILY');
    expect(
      await handler().handle(db.database, turn(seeded, 'DAILY', [], inbound, ANSWERED_AT)),
    ).toEqual({
      claimed: true,
      outcome: 'cadence_daily',
      reply: CHECK_IN_DAILY_ACK.en,
      templateKey: CHECK_IN_ACK_TEMPLATE_KEY,
    });
    expect((await readPrefs(seeded.familyId))?.cadence).toBe('daily');
  });

  it('takes LESS the next afternoon, long after the ask lapsed', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const nextAfternoon = new Date('2026-07-06T18:00:00.000Z');
    expect(await openQuestions(seeded, nextAfternoon)).toEqual([]);

    const inbound = await seedInbound(seeded, 'LESS');
    expect(
      await handler().handle(db.database, turn(seeded, 'LESS', [], inbound, nextAfternoon)),
    ).toEqual({
      claimed: true,
      outcome: 'cadence_weekly',
      reply: CHECK_IN_WEEKLY_ACK.en,
      templateKey: CHECK_IN_ACK_TEMPLATE_KEY,
    });
    expect((await readPrefs(seeded.familyId))?.cadence).toBe('weekly');
  });

  /** Another lane speaking after the evening question — the state that ends this lane's
   * claim on the taught words. */
  async function seedOtherLaneOutbound(seeded: Seeded, createdAt: Date) {
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      status: 'queued',
      createdAt,
    });
  }

  /** 14:00 Toronto the day after ASKED_AT: the evening has lapsed. */
  const NEXT_AFTERNOON = new Date('2026-07-06T18:00:00.000Z');

  it('gives a bare NO and a bare LESS back once another lane has had the last word', async () => {
    for (const body of ['no', 'LESS']) {
      const seeded = await seedFamily();
      // Asked three weeks ago; a nudge two days ago is the last thing Hale said.
      await seedAsk(seeded, { createdAt: new Date(ASKED_AT.getTime() - 21 * 24 * 3_600_000) });
      await seedOtherLaneOutbound(seeded, new Date(ASKED_AT.getTime() - 2 * 24 * 3_600_000));
      const inbound = await seedInbound(seeded, body);

      expect(
        await handler().handle(db.database, turn(seeded, body, [], inbound, NEXT_AFTERNOON)),
        body,
      ).toEqual({ claimed: false });
      expect(await readPrefs(seeded.familyId), body).toBeUndefined();
      await db.exec('truncate table families, users cascade');
    }
  });

  it('still takes DAILY as the way back in, for thirty days after Hale slowed down', async () => {
    // Off the constant, a day either side of it: 21-vs-40 would hold with the window at
    // any length in between, and the window IS the rule here.
    for (const [askedDaysAgo, claimed] of [
      [CHECK_IN_REOFFER_DAYS - 1, true],
      [CHECK_IN_REOFFER_DAYS + 1, false],
    ] as const) {
      const seeded = await seedFamily();
      await seedAsk(seeded, {
        createdAt: new Date(NEXT_AFTERNOON.getTime() - askedDaysAgo * 24 * 3_600_000),
      });
      await seedOtherLaneOutbound(seeded, new Date(NEXT_AFTERNOON.getTime() - 2 * 24 * 3_600_000));
      // Hale has stopped asking — which is the only state DAILY has anything to say about.
      await db.database
        .insert(schema.familyCheckInPrefs)
        .values({ familyId: seeded.familyId, cadence: 'off' });
      const inbound = await seedInbound(seeded, 'DAILY');

      const verdict = await handler().handle(
        db.database,
        turn(seeded, 'DAILY', [], inbound, NEXT_AFTERNOON),
      );
      expect(verdict, `${askedDaysAgo} days`).toEqual(
        claimed
          ? {
              claimed: true,
              outcome: 'cadence_daily',
              reply: CHECK_IN_DAILY_ACK.en,
              templateKey: CHECK_IN_ACK_TEMPLATE_KEY,
            }
          : { claimed: false },
      );
      expect((await readPrefs(seeded.familyId))?.cadence, `${askedDaysAgo} days`).toBe(
        claimed ? 'daily' : 'off',
      );
      await db.exec('truncate table families, users cascade');
    }
  });

  it('lets the last word go stale after thirty days, even with nothing said since', async () => {
    // The lane holding the floor is not the same as the lane having spoken recently: a
    // household Hale asked once and then never texted again would otherwise have 'no'
    // claimed for the rest of their life.
    for (const [askedDaysAgo, claimed] of [
      [CHECK_IN_REOFFER_DAYS - 1, true],
      [CHECK_IN_REOFFER_DAYS + 1, false],
    ] as const) {
      const seeded = await seedFamily();
      await seedAsk(seeded, {
        createdAt: new Date(NEXT_AFTERNOON.getTime() - askedDaysAgo * 24 * 3_600_000),
      });
      const inbound = await seedInbound(seeded, 'no');

      expect(
        await handler().handle(db.database, turn(seeded, 'no', [], inbound, NEXT_AFTERNOON)),
        `${askedDaysAgo} days`,
      ).toEqual(
        claimed
          ? {
              claimed: true,
              outcome: 'cadence_off',
              reply: CHECK_IN_OFF_ACK.en,
              templateKey: CHECK_IN_ACK_TEMPLATE_KEY,
            }
          : { claimed: false },
      );
      expect((await readPrefs(seeded.familyId))?.cadence, `${askedDaysAgo} days`).toBe(
        claimed ? 'off' : undefined,
      );
      await db.exec('truncate table families, users cascade');
    }
  });

  it('hands DAILY to the coach for a household that is already on nightly', async () => {
    // The reoffer window exists to un-quit a family Hale stopped asking. A family it asks
    // every evening has nothing to return from, so the word is about something else.
    const seeded = await seedFamily();
    await seedAsk(seeded, {
      createdAt: new Date(NEXT_AFTERNOON.getTime() - 21 * 24 * 3_600_000),
    });
    await seedOtherLaneOutbound(seeded, new Date(NEXT_AFTERNOON.getTime() - 2 * 24 * 3_600_000));
    await db.database
      .insert(schema.familyCheckInPrefs)
      .values({ familyId: seeded.familyId, cadence: 'daily' });
    const inbound = await seedInbound(seeded, 'DAILY');

    expect(
      await handler().handle(db.database, turn(seeded, 'DAILY', [], inbound, NEXT_AFTERNOON)),
    ).toEqual({ claimed: false });
  });

  it('leaves a bare NO alone for a family Hale has never asked', async () => {
    const seeded = await seedFamily();
    const inbound = await seedInbound(seeded, 'no');
    expect(
      await handler().handle(db.database, turn(seeded, 'no', [], inbound, ANSWERED_AT)),
    ).toEqual({ claimed: false });
    expect(await readPrefs(seeded.familyId)).toBeUndefined();
  });

  it('is a way back in and nothing more: DAILY returns, a bare NO does not', async () => {
    // A stepped-down household, another lane speaking since: the reoffer window is open,
    // and it is open for exactly one word. Without that narrowing a bare NO out here
    // would be a cadence change filed off a word the parent meant for somebody else.
    for (const [body, claimed, cadence] of [
      ['no', false, 'weekly'],
      ['DAILY', true, 'daily'],
    ] as const) {
      const seeded = await seedFamily();
      await seedAsk(seeded, {
        templateKey: CHECK_IN_STEP_DOWN_TEMPLATE_KEY,
        createdAt: new Date(NEXT_AFTERNOON.getTime() - 21 * 24 * 3_600_000),
      });
      await seedOtherLaneOutbound(seeded, new Date(NEXT_AFTERNOON.getTime() - 2 * 24 * 3_600_000));
      await db.database
        .insert(schema.familyCheckInPrefs)
        .values({ familyId: seeded.familyId, cadence: 'weekly' });
      const inbound = await seedInbound(seeded, body);

      expect(
        await handler().handle(db.database, turn(seeded, body, [], inbound, NEXT_AFTERNOON)),
        body,
      ).toEqual(
        claimed
          ? {
              claimed: true,
              outcome: 'cadence_daily',
              reply: CHECK_IN_DAILY_ACK.en,
              templateKey: CHECK_IN_ACK_TEMPLATE_KEY,
            }
          : { claimed: false },
      );
      expect((await readPrefs(seeded.familyId))?.cadence, body).toBe(cadence);
      await db.exec('truncate table families, users cascade');
    }
  });

  it('holds no floor on an ask that never reached the phone', async () => {
    // A 'failed' row consumed the dedupe key and sent nothing. The parent was never
    // asked, so there is no conversation for their 'no' to be the end of.
    const seeded = await seedFamily();
    await seedAsk(seeded, { status: 'failed' });
    const inbound = await seedInbound(seeded, 'no');
    expect(
      await handler().handle(db.database, turn(seeded, 'no', [], inbound, NEXT_AFTERNOON)),
    ).toEqual({ claimed: false });
    expect(await readPrefs(seeded.familyId)).toBeUndefined();
  });

  it('does not read a keyword off the wrong door', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const inbound = await seedInbound(seeded, 'no', 'email');
    expect(
      await handler().handle(db.database, turn(seeded, 'no', [], inbound, ANSWERED_AT)),
    ).toEqual({ claimed: false });
    expect(await readPrefs(seeded.familyId)).toBeUndefined();
  });
});

/**
 * THE ACK IS THE LANE'S OWN LAST WORD — driven through the REAL router.
 *
 * Everything above calls the handler directly, which can only ever prove what the lane
 * decides GIVEN a ledger. This proves the ledger: the thank-you Hale sends back is written
 * by `sendReply`, and whether that row is recognisable as this lane's is a fact about what
 * the router wrote, not about what the handler intended. A stubbed insert would have the
 * test stipulating the one thing in question.
 */
describe("the floor after Hale's own thank-you, through the real router", () => {
  const PHONE = '+14165550123';
  /** 14:00 Toronto the day after the ask: the evening has lapsed. */
  const NEXT_AFTERNOON = new Date('2026-07-06T18:00:00.000Z');
  /** 22:00 the evening of the ask — another turn, after the ack. */
  const LATER_THAT_EVENING = new Date('2026-07-06T02:00:00.000Z');
  /** 07:30 the next morning: inside the window by half an hour, so the answer still
   * lands and Hale thanks the parent for it. An ACK sent at breakfast. */
  const NEXT_MORNING = new Date('2026-07-06T11:30:00.000Z');
  /** 10:00 and 10:05 that same morning — the coach takes a turn, then one bare word. */
  const MID_MORNING = new Date('2026-07-06T14:00:00.000Z');
  const FIVE_MINUTES_LATER = new Date('2026-07-06T14:05:00.000Z');

  let transport: FakeReplyTransport;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function seedReachable(): Promise<Seeded> {
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    transport = new FakeReplyTransport();
    const seeded = await seedFamily();
    await db.database.insert(schema.parentChannels).values({
      familyId: seeded.familyId,
      userId: seeded.parentUserId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: ASKED_AT,
    });
    return seeded;
  }

  function deps(now: Date, coachReply: string): ChannelRouterDeps {
    return {
      database: db.database,
      loadContext: loadInboundContext,
      transport,
      handlers: defaultHandlers(),
      questions: defaultOpenQuestionReader(),
      offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
      coach: {
        async respond() {
          return { reply: coachReply, planOffer: null, activityPromise: null, spotWatch: null };
        },
      },
      smokeAlarm: auditSmokeAlarmClaim(db.database),
      turns: auditTurnLedger(db.database),
      apology: { compose: async () => ({ status: 'composed', reply: 'sorry' }) },
      recordPlanOffer: async () => ({ status: 'recorded' }),
      recordActivityPromise: async () => ({
        status: 'recorded',
        commitmentId: '77777777-7777-4777-8777-777777777777',
      }),
      replyResolver: { read: async () => ({ status: 'unresolved', reason: 'no_target' }) },
      disambiguation: createDisambiguationStore(),
      reconcileView: loadReconcileView,
      recordStatedState: async () => ({ status: 'nothing_stated' }),
      weekdayCareAnswerTarget: async () => ({ status: 'no_open_ask' as const }),
      recordWeekdayCare: async (_db, input) => ({
        status: 'recorded' as const,
        care: input.care,
        providerNamed: input.provider !== null,
      }),
      recordRegistrationWatch: async () => ({ status: 'recorded' }),
      armWatchedSpot: async () => ({ status: 'armed', spotId: 'spot-1' }),
      dispatchDeepResearch: async () => ({ status: 'enqueued' }),
      limiter: new FakeRateLimiter(() => now.getTime()),
      now: () => now,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  }

  /** One text from the parent, routed. `channel_messages.created_at` defaults to the
   * DATABASE clock and these turns are staged on a July timeline, so whatever the router
   * wrote is moved onto it afterwards — every reader under test orders by created_at. */
  async function text(seeded: Seeded, body: string, at: Date, coachReply = 'Sure thing.') {
    const providerMessageId = `SM-${at.getTime()}`;
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        providerMessageId,
        status: 'delivered',
        body,
        createdAt: at,
        sentAt: at,
      })
      .returning({ id: schema.channelMessages.id });
    const result = await routeChannelMessage(deps(at, coachReply), {
      family_id: seeded.familyId,
      parent_user_id: seeded.parentUserId,
      channel_message_id: row?.id as string,
      provider_message_id: providerMessageId,
      received_at: at.toISOString(),
    });
    await db.database
      .update(schema.channelMessages)
      .set({ createdAt: at })
      .where(
        and(
          eq(schema.channelMessages.familyId, seeded.familyId),
          eq(schema.channelMessages.direction, 'out'),
          gt(schema.channelMessages.createdAt, at),
        ),
      );
    return result;
  }

  async function outboundKeys(familyId: string): Promise<(string | null)[]> {
    const rows = await db.database
      .select({ templateKey: schema.channelMessages.templateKey })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, familyId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    return rows.map((row) => row.templateKey);
  }

  it('takes NO the afternoon after an answered evening, because its own ack is the last word', async () => {
    const seeded = await seedReachable();
    await seedAsk(seeded);

    const answered = await text(seeded, 'quiet one', ANSWERED_AT);
    expect(answered.handler).toBe('evening_check_in');
    expect(transport.bodies()).toEqual([notedAck(seeded.familyId, ANSWERED_AT)]);
    // The thank-you is NAMED in the ledger — the whole of what makes the next turn work.
    expect(await outboundKeys(seeded.familyId)).toEqual([
      CHECK_IN_ASK_TEMPLATE_KEY,
      CHECK_IN_ACK_TEMPLATE_KEY,
    ]);

    const dropped = await text(seeded, 'NO', NEXT_AFTERNOON);
    expect(dropped.handler).toBe('evening_check_in');
    expect(transport.bodies()).toEqual([
      notedAck(seeded.familyId, ANSWERED_AT),
      CHECK_IN_OFF_ACK.en,
    ]);
    expect((await readPrefs(seeded.familyId))?.cadence).toBe('off');
  });

  it('gives that same NO to the coach once another turn has answered in between', async () => {
    const seeded = await seedReachable();
    await seedAsk(seeded);

    await text(seeded, 'quiet one', ANSWERED_AT);
    // The positive control for the case above: the ONLY difference is a coach turn after
    // the ack, and it is what ends this lane's claim on the word.
    const asked = await text(seeded, 'what is on saturday?', LATER_THAT_EVENING, 'Swim at 10.');
    expect(asked.status).toBe('agent_replied');

    const declined = await text(seeded, 'NO', NEXT_AFTERNOON, 'Say more?');
    expect(declined.handler).not.toBe('evening_check_in');
    expect((await readPrefs(seeded.familyId))?.cadence).toBe('daily');
  });

  it('does not stretch an evening out of a breakfast thank-you', async () => {
    // The parent answered at 07:30, so the ack went out at 07:30 — and an ack has no
    // evening. If the open window were measured from it, the whole of this local day
    // would belong to this lane, and the 'no' the parent typed at the coach five minutes
    // after the coach answered them would be filed as a cadence change.
    const seeded = await seedReachable();
    await seedAsk(seeded);

    const answered = await text(seeded, 'quiet one', NEXT_MORNING);
    expect(answered.handler).toBe('evening_check_in');
    expect(await outboundKeys(seeded.familyId)).toEqual([
      CHECK_IN_ASK_TEMPLATE_KEY,
      CHECK_IN_ACK_TEMPLATE_KEY,
    ]);

    const asked = await text(seeded, 'what is on saturday?', MID_MORNING, 'Swim at 10.');
    expect(asked.status).toBe('agent_replied');

    const declined = await text(seeded, 'no', FIVE_MINUTES_LATER, 'Say more?');
    expect(declined.handler).not.toBe('evening_check_in');
    expect((await readPrefs(seeded.familyId))?.cadence).toBe('daily');
  });

  it("still takes NO on the evening it asked, with another lane's nudge in between", async () => {
    // The positive control for the case above, and the clause the ASK earns: 20:17 the
    // question, 20:30 a nudge from somewhere else, 21:40 the parent's NO. Hale does not
    // hold the floor, but the evening it asked about is still tonight.
    const seeded = await seedReachable();
    await seedAsk(seeded);
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      status: 'queued',
      createdAt: new Date(ASKED_AT.getTime() + 13 * 60_000),
    });
    expect(await openQuestions(seeded, ANSWERED_AT)).toEqual([]);

    const dropped = await text(seeded, 'NO', ANSWERED_AT);
    expect(dropped.handler).toBe('evening_check_in');
    expect(transport.bodies()).toEqual([CHECK_IN_OFF_ACK.en]);
    expect((await readPrefs(seeded.familyId))?.cadence).toBe('off');
  });
});

describe('the thirty-day purge', () => {
  it('destroys what is past its stamp and leaves the rest', async () => {
    const seeded = await seedFamily();
    const inbound = await seedInbound(seeded, 'good day');
    await handleEveningCheckInReply(db.database, {
      ...seeded,
      body: 'good day',
      askedAt: ASKED_AT,
      timeZone: TZ,
      inboundChannelMessageId: inbound,
      now: ANSWERED_AT,
    });

    const oneDayShort = new Date(
      ANSWERED_AT.getTime() + (NOTE_RETENTION_DAYS - 1) * 24 * 3_600_000,
    );
    expect(await purgeExpiredCheckInNotes(db.database, oneDayShort)).toBe(0);
    expect(await readNotes(seeded.familyId)).toHaveLength(1);

    const pastIt = new Date(ANSWERED_AT.getTime() + (NOTE_RETENTION_DAYS + 1) * 24 * 3_600_000);
    expect(await purgeExpiredCheckInNotes(db.database, pastIt)).toBe(1);
    expect(await readNotes(seeded.familyId)).toEqual([]);
  });
});
