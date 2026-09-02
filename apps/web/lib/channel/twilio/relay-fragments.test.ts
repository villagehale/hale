import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type RelaySocket,
  type VoiceCallRecorder,
  type VoiceTurnStream,
  createRelaySession,
} from './relay-session';
import { mintRelayToken } from './relay-token';

/**
 * ONE THOUGHT, ONE ANSWER — the repetition defect from CA170c1fb0, at the layer that
 * caused it.
 *
 * The founder asked one question about potty training and got the same answer three
 * times in ninety seconds. It was never a memory problem: the turn can see its own prior
 * turns end to end (voice-self-memory.test.ts proves it against a real database). It was
 * that Twilio marks a prompt `last` at every speech-final PAUSE, so a parent who
 * hesitates asks their question two or three times over, and Hale — correctly, from where
 * it sat — answered each one.
 *
 * The bar the merge has to clear is on BOTH sides: fragments become one question, and a
 * genuinely new question on an idle line is still answered on its own, immediately.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const CALL_SID = 'CA00000000000000000000000000000051';
const CONVERSATION_ID = '2b1c6f10-9a4d-4c6b-9a9e-b0b7c0e2f111';
const TICKET = {
  callSid: CALL_SID,
  familyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  parentUserId: '9c858901-8a57-4791-81fe-4c455b099bc9',
};
const NOW = new Date('2026-08-19T15:00:00.000Z');

function fakeSocket() {
  const sent: string[] = [];
  const socket: RelaySocket = {
    send: (frame) => {
      sent.push(frame);
    },
    close: () => {},
  };
  return { socket };
}

function fakeRecorder() {
  return {
    openThread: vi.fn(async () => CONVERSATION_ID),
    callerSaid: vi.fn(async () => {}),
    haleSaid: vi.fn(async () => 'voice-msg-1'),
    callEnded: vi.fn(async () => {}),
  } as unknown as VoiceCallRecorder & { callerSaid: ReturnType<typeof vi.fn> };
}

const setupFrame = () => JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: CALL_SID });
const promptFrame = (voicePrompt: string, last = true) =>
  JSON.stringify({ type: 'prompt', voicePrompt, lang: 'en-US', last });

describe('a caller whose sentence arrives in pieces', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  /** A turn that takes real time, so a fragment can land while it is running — which is
   * the only condition under which the merge fires. */
  function build(turnMs = 5) {
    const asked: string[] = [];
    const respond: VoiceTurnStream['respond'] = async (input, emit) => {
      asked.push(input.prompt);
      await new Promise((resolve) => setTimeout(resolve, turnMs));
      emit('answer');
      return 'spoke';
    };
    const wire = fakeSocket();
    const recorder = fakeRecorder();
    const session = createRelaySession({
      socket: wire.socket,
      token: mintRelayToken(TICKET, NOW),
      turn: { respond },
      recorder,
      claimCall: async () => true,
      promiseSpoken: async () => ({ status: 'no_promise' }) as const,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      now: () => NOW,
    });
    return { session, asked, recorder };
  }

  it('asks the three pieces of one question ONCE, joined, instead of three times', async () => {
    const t = build();
    await t.session.handleMessage(setupFrame());

    // The founder's own sentence, exactly as Twilio delivered it — three frames off the
    // wire with nothing waiting between them, which is how a socket delivers them.
    await Promise.all([
      t.session.handleMessage(promptFrame('My song is')),
      t.session.handleMessage(promptFrame('turning too soon. Like, when should we start')),
      t.session.handleMessage(promptFrame('potty train?')),
    ]);

    expect(t.asked).toEqual([
      'My song is',
      'turning too soon. Like, when should we start potty train?',
    ]);
  });

  /**
   * THE POSITIVE CONTROL. Without it, a merge that swallowed every prompt after the first
   * would pass the test above and silently stop answering people.
   */
  it('answers a question that arrives on an idle line on its own, immediately', async () => {
    const t = build();
    await t.session.handleMessage(setupFrame());

    await t.session.handleMessage(promptFrame('when is swim'));
    await t.session.handleMessage(promptFrame('and when is gym'));

    expect(t.asked).toEqual(['when is swim', 'and when is gym']);
  });

  it('still ignores a partial transcript — `last: false` is not a question at all', async () => {
    const t = build();
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is', false));

    expect(t.asked).toEqual([]);
  });

  it('writes the caller row for the merged question, not for each piece', async () => {
    const t = build();
    await t.session.handleMessage(setupFrame());

    await Promise.all([
      t.session.handleMessage(promptFrame('when should we start')),
      t.session.handleMessage(promptFrame('potty training')),
    ]);

    expect(t.recorder.callerSaid).toHaveBeenCalledTimes(2);
    expect(t.recorder.callerSaid).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'potty training', turnIndex: 2 }),
    );
  });

  it('keeps answering after a turn that threw — one broken turn does not deafen the call', async () => {
    const asked: string[] = [];
    let calls = 0;
    const respond: VoiceTurnStream['respond'] = async (input, emit) => {
      asked.push(input.prompt);
      calls += 1;
      if (calls === 1) throw new Error('model unavailable');
      emit('answer');
      return 'spoke';
    };
    const wire = fakeSocket();
    const session = createRelaySession({
      socket: wire.socket,
      token: mintRelayToken(TICKET, NOW),
      turn: { respond },
      recorder: fakeRecorder(),
      claimCall: async () => true,
      promiseSpoken: async () => ({ status: 'no_promise' }) as const,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      now: () => NOW,
    });

    await session.handleMessage(setupFrame());
    await session.handleMessage(promptFrame('when is swim'));
    await session.handleMessage(promptFrame('when is gym'));

    expect(asked).toEqual(['when is swim', 'when is gym']);
  });
});
