import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultHandlers, defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import type { HandlerContext } from '~/lib/channel/router/route';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  CHECK_IN_ASK_TEMPLATE_KEY,
  CHECK_IN_DAILY_ACK,
  CHECK_IN_NOTED_ACK,
  CHECK_IN_NOT_KEPT_ACK,
  CHECK_IN_OFF_ACK,
  CHECK_IN_STEP_DOWN_TEMPLATE_KEY,
  CHECK_IN_WEEKLY_ACK,
} from './copy';
import { NOTE_RETENTION_DAYS, purgeExpiredCheckInNotes } from './notes';
import { eveningCheckInQuestion, handleEveningCheckInReply } from './reply';

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
  overrides: { templateKey?: string; createdAt?: Date } = {},
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
      status: 'queued',
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
    expect(outcome).toEqual({ status: 'note_stored', reply: CHECK_IN_NOTED_ACK.en });

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
      reply: CHECK_IN_NOTED_ACK.en,
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
 * The words every message in this lane prints are promised to work "anytime" and "any
 * evening", and the standing question cannot carry that promise: Hale's own thank-you
 * closes it. These are the three moments a parent actually reaches for the keyword.
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
    ).toEqual({ claimed: true, outcome: 'cadence_off', reply: CHECK_IN_OFF_ACK.en });
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
    ).toEqual({ claimed: true, outcome: 'cadence_daily', reply: CHECK_IN_DAILY_ACK.en });
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
    ).toEqual({ claimed: true, outcome: 'cadence_weekly', reply: CHECK_IN_WEEKLY_ACK.en });
    expect((await readPrefs(seeded.familyId))?.cadence).toBe('weekly');
  });

  it('leaves a bare NO alone for a family Hale has never asked', async () => {
    const seeded = await seedFamily();
    const inbound = await seedInbound(seeded, 'no');
    expect(
      await handler().handle(db.database, turn(seeded, 'no', [], inbound, ANSWERED_AT)),
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
