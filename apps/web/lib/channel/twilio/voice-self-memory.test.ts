import type { Skill } from '@hale/agent';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentContext } from '~/lib/coach/context';
import { loadTranscript } from '~/lib/coach/conversation';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type RelaySocket, createRelaySession } from './relay-session';
import { mintRelayToken } from './relay-token';
import { voiceCallRecorder } from './voice-record';
import { voiceTurnStream } from './voice-turn';

/**
 * CAN HALE HEAR ITSELF? — two spoken turns, over the real recorder, the real thread
 * readers and a real Postgres.
 *
 * The founder's verdict after the first live v2 call was that Hale repeats itself, and
 * the standing hypothesis was a BLIND SELF: a turn whose context carries the caller's
 * words and not its own, so every turn is turn one and the same sentence is a reasonable
 * thing to say again. That hypothesis is refutable, and this is what refutes or confirms
 * it — end to end, because the seam it lives on spans four modules: the session writes
 * the turn, the recorder threads it, the transcript reader loads it and the context
 * builder serializes it. A test that fakes any one of those can never see the gap.
 *
 * The MODEL is faked and only the model: `runStreaming` captures the context it was
 * handed and streams a scripted line back. Rule #8 is about agent QUALITY, which is
 * evaluated against real cached responses; what is asserted here is plumbing — whether a
 * string Hale said in turn one is in the bytes turn two is composed from.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const CALL_SID = 'CA00000000000000000000000000000031';
const NOW = new Date('2026-08-19T15:00:00.000Z');

/** What Hale says on turn one. Distinctive enough that finding it in turn two's context
 * cannot be an accident of the fixtures. */
const FIRST_REPLY = 'Swim is Thursday at four thirty, and gym is Saturday morning.';

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

describe('a spoken turn can see what Hale already said out loud', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('carries turn one VERBATIM into the context turn two is composed from', async () => {
    const family = await seedFamily(db.database);
    const ticket = { callSid: CALL_SID, ...family };
    const token = mintRelayToken(ticket, NOW);

    const skill: Skill = {
      meta: { name: 'voice-turn', whenToUse: 'a call', task: 'speak', tools: [] },
      instructions: 'speak briefly',
    };

    /** Every context the model was handed, in turn order. */
    const contexts: unknown[] = [];
    const replies = [FIRST_REPLY, 'Nothing else this week.'];

    const socket = fakeSocket();
    const session = createRelaySession({
      socket: socket.socket,
      token,
      recorder: voiceCallRecorder(db.database),
      claimCall: async () => true,
      promiseSpoken: async () => ({ status: 'no_promise' }) as const,
      turn: voiceTurnStream({
        loadSkill: async () => skill,
        loadTranscript: (conversationId) => loadTranscript(conversationId, db.database),
        loadContext: (input) => loadAgentContext(input, db.database),
        answerSpoken: async () => ({ status: 'not_an_answer' }) as const,
        buildTools: () => [],
        client: () => ({ messages: {} }) as never,
        runStreaming: async (args) => {
          contexts.push(args.context);
          const answer = replies[contexts.length - 1] ?? '';
          args.onTextDelta(answer);
          return {
            answer,
            steps: 1,
            hitMaxSteps: false,
            truncatedRetries: 0,
            usage: {
              promptTokens: 10,
              completionTokens: 5,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          };
        },
        guardDeps: {} as never,
        recordRun: async () => {},
        log: { error: vi.fn() },
        now: () => NOW,
      }),
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      now: () => NOW,
    });

    await session.handleMessage(JSON.stringify({ type: 'setup', callSid: CALL_SID }));
    await session.handleMessage(
      JSON.stringify({ type: 'prompt', voicePrompt: "what's on this week", last: true }),
    );
    await session.handleMessage(
      JSON.stringify({ type: 'prompt', voicePrompt: 'anything else', last: true }),
    );

    expect(contexts).toHaveLength(2);
    // The whole point: what Hale SAID, not merely that a turn happened.
    expect(JSON.stringify(contexts[1])).toContain(FIRST_REPLY);
    // A positive control on the reader itself — the caller's own first turn is in there
    // too, so a failure above is about Hale's side and not about an empty transcript.
    expect(JSON.stringify(contexts[1])).toContain("what's on this week");
  });
});
