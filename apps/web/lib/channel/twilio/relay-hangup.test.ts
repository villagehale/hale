import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_TURN_FAILED } from './copy';
import {
  type RelaySocket,
  type VoiceCallRecorder,
  type VoiceTurnStream,
  createRelaySession,
} from './relay-session';
import { mintRelayToken } from './relay-token';

/**
 * HALE HANGS UP — the end of the founder's first real v2 call, as a gate.
 *
 * Three goodbyes reached a live line on CA170c1fb0 ("And that's all for today.", "Yeah.
 * It's ciao. Bye bye.", "You can you can hang up now."), each got an answer, and in the
 * end the parent hung up on Hale.
 *
 * WHICH HALF THIS FILE OWNS. Deciding that an utterance WAS a goodbye is voice-goodbye.ts
 * and is tested there against the founder's own words. What is asserted here is the wire:
 * the words, then the token that says the turn is over, then the row, then the end frame.
 * Get that order wrong and the caller hears a click instead of a goodbye — which is the
 * failure the fix was for, arriving from the other side.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const CALL_SID = 'CA00000000000000000000000000000041';
const CONVERSATION_ID = '2b1c6f10-9a4d-4c6b-9a9e-b0b7c0e2f111';
const TICKET = {
  callSid: CALL_SID,
  familyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  parentUserId: '9c858901-8a57-4791-81fe-4c455b099bc9',
};
const NOW = new Date('2026-08-19T15:00:00.000Z');

function fakeSocket() {
  const sent: string[] = [];
  let closed = false;
  const socket: RelaySocket = {
    send: (frame) => {
      sent.push(frame);
    },
    close: () => {
      closed = true;
    },
  };
  return {
    socket,
    frames: () => sent.map((f) => JSON.parse(f) as Record<string, unknown>),
    spoken: () =>
      sent
        .map((f) => JSON.parse(f) as { type: string; token?: string })
        .filter((f) => f.type === 'text')
        .map((f) => f.token ?? '')
        .join(''),
    isClosed: () => closed,
  };
}

function fakeRecorder() {
  const calls = {
    openThread: vi.fn(async () => CONVERSATION_ID),
    callerSaid: vi.fn(async () => {}),
    haleSaid: vi.fn(async () => 'voice-msg-1'),
    callEnded: vi.fn(async () => {}),
  };
  return calls as unknown as VoiceCallRecorder & typeof calls;
}

const setupFrame = () => JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: CALL_SID });
const promptFrame = (voicePrompt: string) =>
  JSON.stringify({ type: 'prompt', voicePrompt, lang: 'en-US', last: true });

describe('createRelaySession — a turn that ends the call', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  function build(respond: VoiceTurnStream['respond']) {
    const wire = fakeSocket();
    const recorder = fakeRecorder();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const session = createRelaySession({
      socket: wire.socket,
      token: mintRelayToken(TICKET, NOW),
      turn: { respond },
      recorder,
      claimCall: async () => true,
      promiseSpoken: async () => ({ status: 'no_promise' }) as const,
      log,
      now: () => NOW,
    });
    return { ...wire, session, log, recorder };
  }

  const saysGoodbye: VoiceTurnStream['respond'] = async (_input, emit) => {
    emit('Talk soon.');
    return 'call_ended_by_hale';
  };

  it('speaks the line, closes the turn, THEN puts the phone down', async () => {
    const t = build(saysGoodbye);
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('bye bye'));

    expect(t.frames()).toEqual([
      { type: 'text', token: 'Talk soon.', last: false },
      { type: 'text', token: '', last: true },
      { type: 'end', handoffData: JSON.stringify({ reasonCode: 'call_ended_by_hale' }) },
    ]);
    expect(t.isClosed()).toBe(true);
  });

  it('records the goodbye in the thread and files the call under who ended it', async () => {
    const t = build(saysGoodbye);
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('bye bye'));

    expect(t.recorder.haleSaid).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Talk soon.', turnIndex: 1 }),
    );
    expect(t.recorder.callEnded).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'call_ended_by_hale', turns: 1 }),
    );
  });

  it('writes the one call row exactly once when the socket closes behind its own hang-up', async () => {
    const t = build(saysGoodbye);
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('bye bye'));
    await t.session.handleClose();

    expect(t.recorder.callEnded).toHaveBeenCalledTimes(1);
  });

  /**
   * The positive control that makes the three above mean anything: an ORDINARY turn
   * travels every one of the same lines and must leave the call up. Without it, a
   * `hangUp` wired to fire on every turn would still pass all three.
   */
  it('leaves the line up for a turn that merely spoke', async () => {
    const t = build(async (_input, emit) => {
      emit('Gym is Saturday.');
      return 'spoke';
    });
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is gym'));

    expect(t.frames().some((f) => f.type === 'end')).toBe(false);
    expect(t.isClosed()).toBe(false);
    expect(t.recorder.callEnded).not.toHaveBeenCalled();
  });

  it('never hangs up on a turn that BROKE — a lost answer is not a finished call', async () => {
    const t = build(async () => {
      throw new Error('model unavailable');
    });
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is gym'));

    expect(t.spoken()).toContain(VOICE_TURN_FAILED);
    expect(t.frames().some((f) => f.type === 'end')).toBe(false);
    expect(t.isClosed()).toBe(false);
  });
});
