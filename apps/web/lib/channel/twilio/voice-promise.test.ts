import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindActivityReader, productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type RelaySocket, createRelaySession } from './relay-session';
import { mintRelayToken } from './relay-token';
import { voiceCallRecorder } from './voice-record';
import { SPOKEN_PROMISE_DUE_HOURS, defaultVoicePromisePorts, voicePromiseRecorder } from './voice-promise';

/**
 * VIL-313 · WHAT HALE SAID OUT LOUD ON CA170c1fb0, REPLAYED — end to end, over real
 * Postgres.
 *
 * The two sentences below are verbatim from the founder call (2026-08-26, 03:11-03:14Z).
 * Both are Hale promising to text; both produced ZERO rows in `agent_commitments`, and no
 * text ever followed. The seam that failed spans four modules — the claim extractor, the
 * session, the recorder and the ledger — so nothing short of the whole path can see the
 * gap: a test that fakes the extractor proves only that a fake matched, and one that
 * fakes the ledger proves only that a writer was called.
 *
 * REAL HERE: `extractStateClaims`, `recordActivityPromise`, the voice recorder, the relay
 * session, and Postgres. FAKED: the socket and the model's WORDS. What the model chooses
 * to say is the eval's job (rule #8); what is asserted here is whether a sentence it says
 * becomes a row.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const CALL_SID = 'CA00000000000000000000000000000313';
const NOW = new Date('2026-08-26T03:11:00.000Z');

/** Verbatim, 03:11Z. */
const PROMISE_DETAILS = "Once I've got the details locked down I'll text you.";
/** Verbatim, 03:14Z — the one the parent said "Yes" to. */
const PROMISE_BREAKDOWN = "I'll send you the Three-Day Potty breakdown after this call.";
/** A turn that answers and promises nothing. */
const NO_PROMISE = 'Swim is Thursday at four thirty.';

function fakeSocket() {
  const sent: string[] = [];
  const socket: RelaySocket = {
    send: (frame) => {
      sent.push(frame);
    },
    close: () => {},
  };
  return { socket, sent };
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function openCommitments(database: Database, familyId: string) {
  return database
    .select({
      kind: schema.agentCommitments.commitmentKind,
      summary: schema.agentCommitments.summary,
      topic: schema.agentCommitments.topic,
      dueAt: schema.agentCommitments.dueAt,
      createdFrom: schema.agentCommitments.createdFrom,
      cancelledAt: schema.agentCommitments.cancelledAt,
    })
    .from(schema.agentCommitments)
    .where(eq(schema.agentCommitments.familyId, familyId));
}

/**
 * One spoken turn through the REAL session, the REAL recorder and the REAL promise
 * writer. `spoken` is what the model streams; `asked` is what the caller said.
 */
async function speak(options: {
  familyId: string;
  parentUserId: string;
  asked: string;
  spoken: string;
  /** Drop the mint — the mutation that proves the assertions below can fail. */
  withoutPromiseWriter?: boolean;
}) {
  const ticket = {
    callSid: CALL_SID,
    familyId: options.familyId,
    parentUserId: options.parentUserId,
  };
  const promises = voicePromiseRecorder(
    db.database,
    defaultVoicePromisePorts(bindActivityReader(db.database, productionActivityFamilyReader())),
  );
  const socket = fakeSocket();
  const session = createRelaySession({
    socket: socket.socket,
    token: mintRelayToken(ticket, NOW),
    recorder: voiceCallRecorder(db.database),
    claimCall: async () => true,
    promiseSpoken: options.withoutPromiseWriter
      ? async () => ({ status: 'no_promise' }) as const
      : (input) => promises.record(input),
    turn: {
      respond: async (_input, emit) => {
        emit(options.spoken);
        return 'spoke' as const;
      },
    },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    now: () => NOW,
  });

  await session.handleMessage(JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: CALL_SID }));
  await session.handleMessage(
    JSON.stringify({ type: 'prompt', voicePrompt: options.asked, lang: 'en-US', last: true }),
  );
  return promises;
}

describe('a promise Hale speaks on a call becomes a row', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it.each([
    ['the 03:11 promise', PROMISE_DETAILS, 'toddler swim lessons this fall'],
    ['the 03:14 promise', PROMISE_BREAKDOWN, 'how do we start potty training'],
  ])(
    '%s writes ONE open activity_followup row, due in two hours, against the turn the caller heard',
    async (_label, spoken, asked) => {
      const family = await seedFamily(db.database);
      await speak({ ...family, asked, spoken });

      const rows = await openCommitments(db.database, family.familyId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.kind).toBe('activity_followup');
      expect(row?.cancelledAt).toBeNull();
      // The summary a founder digest and the coach's own open-loops recitation read back.
      // It has to name what Hale is coming back about, or it is a debt nobody can act on.
      expect(row?.summary).toBe(`A promise to come back with what I find on ${asked}`);
      expect(row?.topic).toBe(asked);
      expect(row?.dueAt).toEqual(
        new Date(NOW.getTime() + SPOKEN_PROMISE_DUE_HOURS * 3_600_000),
      );

      // Minted against the outbound VOICE row — the thing that says the caller heard it.
      const [carrier] = await db.database
        .select({
          channel: schema.channelMessages.channel,
          direction: schema.channelMessages.direction,
        })
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.id, row?.createdFrom ?? ''));
      expect(carrier).toEqual({ channel: 'voice', direction: 'out' });
    },
  );

  /**
   * THE MUTATION. Same call, same words, the writer removed — and the assertions above
   * go red rather than passing on an empty table. Without this the positive cases could
   * be satisfied by any row from anywhere.
   */
  it('MUTATION: with the promise writer dropped, the same spoken promise leaves nothing behind', async () => {
    const family = await seedFamily(db.database);
    await speak({
      ...family,
      asked: 'toddler swim lessons this fall',
      spoken: PROMISE_BREAKDOWN,
      withoutPromiseWriter: true,
    });

    expect(await openCommitments(db.database, family.familyId)).toEqual([]);
  });

  it('a turn that answers and promises nothing leaves no debt', async () => {
    const family = await seedFamily(db.database);
    await speak({ ...family, asked: 'when is swim', spoken: NO_PROMISE });

    expect(await openCommitments(db.database, family.familyId)).toEqual([]);
  });

  /**
   * The POSITIVE CONTROL for the negative above: the same family, the same session, one
   * promising turn — so "no rows" is a fact about the sentence rather than about a path
   * that cannot write at all.
   */
  it('the same family DOES get a row the moment a turn promises', async () => {
    const family = await seedFamily(db.database);
    await speak({ ...family, asked: 'when is swim', spoken: NO_PROMISE });
    expect(await openCommitments(db.database, family.familyId)).toEqual([]);

    await speak({ ...family, asked: 'fall gymnastics', spoken: PROMISE_DETAILS });
    expect(await openCommitments(db.database, family.familyId)).toHaveLength(1);
  });

  /**
   * The SEARCH VERB's subject beats the caller's utterance. It already cleared phase 0
   * inside the tool and it says what Hale is coming back about; the utterance is the
   * fallback for the shape that produced the defect — a model that says the sentence and
   * calls nothing.
   */
  it('prefers the subject the search verb registered over the raw utterance', async () => {
    const family = await seedFamily(db.database);
    const promises = voicePromiseRecorder(
      db.database,
      defaultVoicePromisePorts(bindActivityReader(db.database, productionActivityFamilyReader())),
    );
    promises.collect({ subject: 'toddler gymnastics this fall', childId: null });

    const outcome = await promises.record({
      familyId: family.familyId,
      heard: PROMISE_DETAILS,
      asked: 'uh so I was wondering about, you know, gymnastics maybe',
      channelMessageId: await seedOutbound(db.database, family),
      now: NOW,
    });

    expect(outcome.status).toBe('recorded');
    const [row] = await openCommitments(db.database, family.familyId);
    expect(row?.topic).toBe('toddler gymnastics this fall');
  });

  /**
   * The turn was never written down, so there is nothing to point the parent at. NAMED
   * rather than silent (rule #11): the caller heard the promise either way, and an
   * operator has to be able to tell this apart from "nothing was promised".
   */
  it('names the refusal when the spoken turn has no ledger row to hang the debt on', async () => {
    const family = await seedFamily(db.database);
    const promises = voicePromiseRecorder(
      db.database,
      defaultVoicePromisePorts(bindActivityReader(db.database, productionActivityFamilyReader())),
    );

    expect(
      await promises.record({
        familyId: family.familyId,
        heard: PROMISE_BREAKDOWN,
        asked: 'potty training',
        channelMessageId: null,
        now: NOW,
      }),
    ).toEqual({ status: 'not_recorded', reason: 'no_ledger_row' });
    expect(await openCommitments(db.database, family.familyId)).toEqual([]);
  });

  /**
   * A subject that names a member of the household may not be stored: the sweep hands
   * this string to `web_search` a couple of hours later with no model between it and the
   * border (rule #1). The parent still heard the promise, so the refusal is loud.
   */
  it('refuses to store a subject that names somebody in the household', async () => {
    const family = await seedFamily(db.database);
    await db.database
      .insert(schema.children)
      .values({ familyId: family.familyId, name: 'Noah', dateOfBirth: '2025-02-20' });
    const log = { error: vi.fn(), info: vi.fn() };
    const promises = voicePromiseRecorder(db.database, {
      ...defaultVoicePromisePorts(
        bindActivityReader(db.database, productionActivityFamilyReader()),
      ),
      log,
    });

    expect(
      await promises.record({
        familyId: family.familyId,
        heard: PROMISE_DETAILS,
        asked: 'what swim class suits Noah',
        channelMessageId: await seedOutbound(db.database, family),
        now: NOW,
      }),
    ).toEqual({ status: 'not_recorded', reason: 'subject_refused' });
    expect(await openCommitments(db.database, family.familyId)).toEqual([]);
    // Loud, and never the subject itself — the refusal exists because that string held
    // something.
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('Noah');
  });
});

/** An outbound voice row for the promise to be minted against. */
async function seedOutbound(
  database: Database,
  family: { familyId: string; parentUserId: string },
): Promise<string> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'voice',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      body: null,
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('seedOutbound: insert returned no row');
  return row.id;
}
