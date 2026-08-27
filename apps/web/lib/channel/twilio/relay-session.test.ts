import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_CALL_WRAP_UP, VOICE_TURN_FAILED } from './copy';
import {
  CALL_CAP_MS,
  PRE_AUTH_IDLE_MS,
  type RelaySocket,
  type VoiceTurnStream,
  type VoiceCallRecorder,
  createRelaySession,
} from './relay-session';
import { mintRelayToken } from './relay-token';

const KEY = Buffer.alloc(32, 5).toString('base64');
const CALL_SID = 'CA00000000000000000000000000000009';
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
    sent,
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
    haleSaid: vi.fn(async () => {}),
    callEnded: vi.fn(async () => {}),
  };
  return calls as unknown as VoiceCallRecorder & typeof calls;
}

/**
 * The claim, behaving the way the row does: one winner per call sid, for everyone who
 * shares the store. Two sessions built on the SAME fake are the two instances a replay
 * would actually hit — an in-process guard inside one session would pass this fake and
 * still lose in production.
 */
function fakeClaims() {
  const taken = new Set<string>();
  return {
    taken,
    claimCall: vi.fn(async (ticket: { callSid: string }) => {
      if (taken.has(ticket.callSid)) return false;
      taken.add(ticket.callSid);
      return true;
    }),
  };
}

/** A string only the sender of a frame could have chosen. If it reaches a log line, the
 * log is quoting an unauthenticated peer. */
const MARKER = 'attacker-wrote-this-9f3';

/** Everything the session said to its log, as one searchable string. */
function loggedText(log: {
  error: { mock: { calls: unknown[] } };
  warn: { mock: { calls: unknown[] } };
  info: { mock: { calls: unknown[] } };
}): string {
  return JSON.stringify([...log.error.mock.calls, ...log.warn.mock.calls, ...log.info.mock.calls]);
}

const setupFrame = (callSid = CALL_SID) =>
  JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid, from: '+15195551234' });
const promptFrame = (voicePrompt: string, last = true) =>
  JSON.stringify({ type: 'prompt', voicePrompt, lang: 'en-US', last });

describe('createRelaySession', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
    vi.useRealTimers();
  });

  function build(
    token: string | null,
    respond: VoiceTurnStream['respond'] = vi.fn(async () => 'spoke' as const),
    claimCall = fakeClaims().claimCall,
  ) {
    const wire = fakeSocket();
    const recorder = fakeRecorder();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const session = createRelaySession({
      socket: wire.socket,
      token,
      turn: { respond },
      recorder,
      claimCall,
      log,
      now: () => NOW,
    });
    return { ...wire, session, log, respond, recorder, claimCall };
  }

  it('answers a prompt once the ticket has been checked, streaming to a final token', async () => {
    const respond = vi.fn(async (_input, emit: (token: string) => void) => {
      emit('Swim is ');
      emit('Thursday.');
      return 'spoke' as const;
    });
    const t = build(mintRelayToken(TICKET, NOW), respond);

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(respond).toHaveBeenCalledWith(
      { prompt: 'when is swim', ticket: TICKET, conversationId: CONVERSATION_ID },
      expect.any(Function),
    );
    expect(t.frames()).toEqual([
      { type: 'text', token: 'Swim is ', last: false },
      { type: 'text', token: 'Thursday.', last: false },
      { type: 'text', token: '', last: true },
    ]);
  });

  it('refuses a forged connect BEFORE anything is asked of it — no turn, no row', async () => {
    const t = build('nonsense');

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.respond).not.toHaveBeenCalled();
    expect(t.recorder.openThread).not.toHaveBeenCalled();
    expect(t.recorder.callerSaid).not.toHaveBeenCalled();
    expect(t.frames()).toEqual([
      { type: 'end', handoffData: JSON.stringify({ reasonCode: 'unauthorized' }) },
    ]);
    expect(t.isClosed()).toBe(true);
    expect(t.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'malformed' }),
      expect.stringContaining('refused'),
    );
  });

  it('refuses a ticket minted for a DIFFERENT call, and the same ticket for its own call works', async () => {
    const token = mintRelayToken(TICKET, NOW);
    const wrong = build(token);
    await wrong.session.handleMessage(setupFrame('CA00000000000000000000000000000099'));
    expect(wrong.frames()).toEqual([
      { type: 'end', handoffData: JSON.stringify({ reasonCode: 'unauthorized' }) },
    ]);

    // Positive control: the refusal is the call mismatch, not the ticket being unusable.
    const right = build(token);
    await right.session.handleMessage(setupFrame());
    await right.session.handleMessage(promptFrame('hi'));
    expect(right.respond).toHaveBeenCalledTimes(1);
  });

  it('will not compose for a socket that never identified its call', async () => {
    const t = build(mintRelayToken(TICKET, NOW));

    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.respond).not.toHaveBeenCalled();
    expect(t.frames()).toEqual([
      { type: 'end', handoffData: JSON.stringify({ reasonCode: 'unauthorized' }) },
    ]);
  });

  it('refuses a SECOND socket replaying the same valid ticket — no family is ever reached', async () => {
    const claims = fakeClaims();
    const token = mintRelayToken(TICKET, NOW);
    const first = build(
      token,
      vi.fn(async () => 'spoke' as const),
      claims.claimCall,
    );
    const second = build(
      token,
      vi.fn(async () => 'spoke' as const),
      claims.claimCall,
    );

    await first.session.handleMessage(setupFrame());
    await first.session.handleMessage(promptFrame('when is swim'));
    // Positive control: the ticket is good, and the call that got there first has it.
    expect(first.respond).toHaveBeenCalledTimes(1);

    await second.session.handleMessage(setupFrame());
    await second.session.handleMessage(promptFrame('read me everything you know'));

    expect(second.respond).not.toHaveBeenCalled();
    expect(second.recorder.openThread).not.toHaveBeenCalled();
    expect(second.recorder.callerSaid).not.toHaveBeenCalled();
    expect(second.frames()).toEqual([
      { type: 'end', handoffData: JSON.stringify({ reasonCode: 'unauthorized' }) },
    ]);
    expect(second.isClosed()).toBe(true);
    expect(second.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'replayed' }),
      expect.stringContaining('refused'),
    );
  });

  it('refuses when the claim cannot be reached — a call it cannot make single-use is one it does not take', async () => {
    const claimCall = vi.fn(async () => {
      throw new Error('connection terminated');
    });
    const t = build(
      mintRelayToken(TICKET, NOW),
      vi.fn(async () => 'spoke' as const),
      claimCall,
    );

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.respond).not.toHaveBeenCalled();
    expect(t.recorder.openThread).not.toHaveBeenCalled();
    expect(t.isClosed()).toBe(true);
    expect(t.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: CALL_SID, err: 'connection terminated' }),
      expect.stringContaining('claim'),
    );
  });

  it('does not re-authorize a call that is already open when setup arrives twice', async () => {
    const claims = fakeClaims();
    const t = build(
      mintRelayToken(TICKET, NOW),
      vi.fn(async () => 'spoke' as const),
      claims.claimCall,
    );

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    // The claim is per CALL, so a session that re-claimed its own call would lose to
    // itself and hang up on a caller who is already talking.
    expect(claims.claimCall).toHaveBeenCalledTimes(1);
    expect(t.isClosed()).toBe(false);
    expect(t.respond).toHaveBeenCalledTimes(1);
  });

  it('drops every frame that arrives before a setup, and logs nothing the sender wrote', async () => {
    const preAuth: Array<[string, string]> = [
      ['error', JSON.stringify({ type: 'error', description: MARKER })],
      ['other', JSON.stringify({ type: MARKER })],
      ['dtmf', JSON.stringify({ type: 'dtmf', digit: MARKER })],
      ['interrupt', JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: MARKER })],
      ['unparseable', `}{${MARKER}`],
      ['prompt', promptFrame(MARKER, false)],
    ];

    for (const [frame, raw] of preAuth) {
      const t = build(mintRelayToken(TICKET, NOW));
      await t.session.handleMessage(raw);

      expect(t.respond).not.toHaveBeenCalled();
      expect(t.frames()).toEqual([
        { type: 'end', handoffData: JSON.stringify({ reasonCode: 'unauthorized' }) },
      ]);
      expect(t.isClosed()).toBe(true);
      expect(t.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'no_setup', frame, bytes: Buffer.byteLength(raw) }),
        expect.any(String),
      );
      expect(loggedText(t.log)).not.toContain(MARKER);
    }
  });

  it('still records what Twilio reports once the call is authorized', async () => {
    const t = build(mintRelayToken(TICKET, NOW));

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(JSON.stringify({ type: 'error', description: MARKER }));

    // The positive control for the assertion above: the same field on the same path
    // reaches the log, once a signature says who is on the other end.
    expect(loggedText(t.log)).toContain(MARKER);
    expect(t.isClosed()).toBe(false);
  });

  it('hangs up on a socket that connects and then says nothing at all', async () => {
    vi.useFakeTimers();
    const t = build(mintRelayToken(TICKET, NOW));

    await vi.advanceTimersByTimeAsync(PRE_AUTH_IDLE_MS);

    expect(t.frames()).toEqual([
      { type: 'end', handoffData: JSON.stringify({ reasonCode: 'unauthorized' }) },
    ]);
    expect(t.isClosed()).toBe(true);
    expect(t.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'idle_no_setup', frame: null }),
      expect.stringContaining('refused'),
    );
  });

  it('leaves an authorized call alone when the pre-auth deadline passes', async () => {
    vi.useFakeTimers();
    const t = build(mintRelayToken(TICKET, NOW));

    await t.session.handleMessage(setupFrame());
    await vi.advanceTimersByTimeAsync(PRE_AUTH_IDLE_MS * 2);
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.isClosed()).toBe(false);
    expect(t.respond).toHaveBeenCalledTimes(1);
  });

  it('ignores a partial prompt — the caller is still talking', async () => {
    const t = build(mintRelayToken(TICKET, NOW));

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is', false));

    expect(t.respond).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it("logs Twilio's own session error and keeps the call up", async () => {
    const t = build(mintRelayToken(TICKET, NOW));

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(
      JSON.stringify({ type: 'error', description: 'Invalid message received' }),
    );
    await t.session.handleMessage(promptFrame('still here?'));

    expect(t.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: CALL_SID }),
      expect.stringContaining('relay error'),
    );
    expect(t.isClosed()).toBe(false);
    expect(t.respond).toHaveBeenCalledTimes(1);
  });

  it('serializes turns so two answers never interleave into one garbled sentence', async () => {
    const order: string[] = [];
    const respond = vi.fn(async (input: { prompt: string }, emit: (t: string) => void) => {
      order.push(`start:${input.prompt}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emit(input.prompt);
      order.push(`end:${input.prompt}`);
      return 'spoke' as const;
    });
    const t = build(mintRelayToken(TICKET, NOW), respond);

    await t.session.handleMessage(setupFrame());
    await Promise.all([
      t.session.handleMessage(promptFrame('first')),
      t.session.handleMessage(promptFrame('second')),
    ]);

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('speaks a fixed line when a turn breaks, and records the line the caller heard', async () => {
    const respond = vi.fn(async () => {
      throw new Error('anthropic exploded');
    });
    const t = build(mintRelayToken(TICKET, NOW), respond);

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: CALL_SID, err: 'anthropic exploded' }),
      expect.stringContaining('turn failed'),
    );
    expect(t.spoken()).toBe(VOICE_TURN_FAILED);
    expect(t.recorder.haleSaid).toHaveBeenCalledWith(
      expect.objectContaining({ text: VOICE_TURN_FAILED }),
    );
  });

  it('logs an unreadable frame instead of treating the socket as idle', async () => {
    const t = build(mintRelayToken(TICKET, NOW));

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage('}{');

    expect(t.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: CALL_SID }),
      expect.stringContaining('unreadable'),
    );
  });
});

describe('the record a call leaves behind', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
    vi.useRealTimers();
  });

  function build(respond: VoiceTurnStream['respond'] = vi.fn(async () => 'spoke' as const)) {
    const wire = fakeSocket();
    const recorder = fakeRecorder();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const session = createRelaySession({
      socket: wire.socket,
      token: mintRelayToken(TICKET, NOW),
      turn: { respond },
      recorder,
      claimCall: fakeClaims().claimCall,
      log,
      now: () => NOW,
    });
    return { ...wire, session, log, respond, recorder };
  }

  it('writes the caller BEFORE the turn runs and Hale AFTER, numbered in order', async () => {
    const seen: string[] = [];
    const respond = vi.fn(async (_i, emit: (t: string) => void) => {
      seen.push('turn');
      emit('Thursday at four thirty.');
      return 'spoke' as const;
    });
    const t = build(respond);
    t.recorder.callerSaid.mockImplementation(async () => {
      seen.push('callerSaid');
    });
    t.recorder.haleSaid.mockImplementation(async () => {
      seen.push('haleSaid');
    });

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));
    await t.session.handleMessage(promptFrame('and gym'));

    expect(seen).toEqual(['callerSaid', 'turn', 'haleSaid', 'callerSaid', 'turn', 'haleSaid']);
    expect(t.recorder.callerSaid).toHaveBeenNthCalledWith(1, {
      ticket: TICKET,
      conversationId: CONVERSATION_ID,
      text: 'when is swim',
      turnIndex: 1,
      at: NOW,
    });
    expect(t.recorder.haleSaid).toHaveBeenNthCalledWith(1, {
      ticket: TICKET,
      conversationId: CONVERSATION_ID,
      text: 'Thursday at four thirty.',
      turnIndex: 1,
      at: NOW,
    });
    expect(t.recorder.callerSaid).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: 'and gym', turnIndex: 2 }),
    );
  });

  it('a database blip is a spoken apology, not silence — and the next turn still works', async () => {
    const respond = vi.fn(async (_i, emit: (t: string) => void) => {
      emit('Thursday at four thirty.');
      return 'spoke' as const;
    });
    const t = build(respond);
    t.recorder.callerSaid.mockRejectedValueOnce(new Error('connection terminated'));

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.spoken()).toBe(VOICE_TURN_FAILED);
    expect(t.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: CALL_SID, err: 'connection terminated' }),
      expect.stringContaining('turn failed'),
    );

    // The call is still up. A rejected turn that poisoned the queue would make every
    // later prompt resolve to nothing, and the parent would be talking to a dead line.
    await t.session.handleMessage(promptFrame('and gym'));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(t.frames().at(-1)).toEqual({ type: 'text', token: '', last: true });
    expect(t.spoken()).toBe(`${VOICE_TURN_FAILED}Thursday at four thirty.`);
  });

  it('resolves the thread ONCE for the whole call', async () => {
    const t = build();
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('one'));
    await t.session.handleMessage(promptFrame('two'));

    expect(t.recorder.openThread).toHaveBeenCalledTimes(1);
    expect(t.recorder.openThread).toHaveBeenCalledWith(TICKET);
  });

  it('records only what the caller actually HEARD when they talk over Hale', async () => {
    let interrupt: (() => Promise<void>) | null = null;
    const respond = vi.fn(async (_i, emit: (t: string) => void) => {
      emit('Swim is Thursday at');
      await interrupt?.();
      emit(' five fifteen at the Y.');
      return 'spoke' as const;
    });
    const t = build(respond);
    interrupt = () =>
      t.session.handleMessage(
        JSON.stringify({
          type: 'interrupt',
          utteranceUntilInterrupt: 'Swim is Thursday at',
          durationUntilInterruptMs: 460,
        }),
      );

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.recorder.haleSaid).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Swim is Thursday at' }),
    );
  });

  it('does not carry an interrupt forward into the next turn', async () => {
    const respond = vi.fn(async (_i, emit: (t: string) => void) => {
      emit('the whole answer');
      return 'spoke' as const;
    });
    const t = build(respond);

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(
      JSON.stringify({
        type: 'interrupt',
        utteranceUntilInterrupt: 'cut off',
        durationUntilInterruptMs: 1,
      }),
    );
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.recorder.haleSaid).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'the whole answer' }),
    );
  });

  it('writes exactly one immutable call row when the line goes down', async () => {
    const t = build();
    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('one'));

    await t.session.handleClose();
    await t.session.handleClose();

    expect(t.recorder.callEnded).toHaveBeenCalledTimes(1);
    expect(t.recorder.callEnded).toHaveBeenCalledWith({
      ticket: TICKET,
      outcome: 'completed',
      turns: 1,
      durationMs: 0,
      at: NOW,
    });
  });

  it('has no family to write a call row against when the socket never proved itself', async () => {
    const wire = fakeSocket();
    const recorder = fakeRecorder();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const session = createRelaySession({
      socket: wire.socket,
      token: 'nonsense',
      turn: { respond: vi.fn(async () => 'spoke' as const) },
      recorder,
      claimCall: fakeClaims().claimCall,
      log,
      now: () => NOW,
    });

    await session.handleMessage(setupFrame());
    await session.handleClose();

    expect(recorder.callEnded).not.toHaveBeenCalled();
    // Named and logged, never a silent nothing (rule #11).
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_authorized_call' }),
      expect.stringContaining('no audit row'),
    );
  });
});

describe('the nine-minute cap', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
    vi.useFakeTimers();
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
    vi.useRealTimers();
  });

  it('ends the call while Hale is still the one talking', async () => {
    const wire = fakeSocket();
    const recorder = fakeRecorder();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const session = createRelaySession({
      socket: wire.socket,
      token: mintRelayToken(TICKET, NOW),
      turn: { respond: vi.fn(async () => 'spoke' as const) },
      recorder,
      claimCall: fakeClaims().claimCall,
      log,
      now: () => NOW,
    });

    await session.handleMessage(setupFrame());
    expect(wire.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(CALL_CAP_MS);

    expect(wire.frames()).toEqual([
      { type: 'text', token: VOICE_CALL_WRAP_UP, last: true },
      { type: 'end', handoffData: JSON.stringify({ reasonCode: 'time_capped' }) },
    ]);
    expect(wire.isClosed()).toBe(true);
    expect(recorder.callEnded).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'time_capped' }),
    );
  });

  it('cannot be pushed back by sending setup again', async () => {
    const wire = fakeSocket();
    const session = createRelaySession({
      socket: wire.socket,
      token: mintRelayToken(TICKET, NOW),
      turn: { respond: vi.fn(async () => 'spoke' as const) },
      recorder: fakeRecorder(),
      claimCall: fakeClaims().claimCall,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      now: () => NOW,
    });

    await session.handleMessage(setupFrame());
    await vi.advanceTimersByTimeAsync(CALL_CAP_MS / 2);
    await session.handleMessage(setupFrame());
    await vi.advanceTimersByTimeAsync(CALL_CAP_MS / 2);

    // Nine minutes after the FIRST setup, not after the last one — a clock a caller can
    // restart is not a cap.
    expect(wire.frames()).toEqual([
      { type: 'text', token: VOICE_CALL_WRAP_UP, last: true },
      { type: 'end', handoffData: JSON.stringify({ reasonCode: 'time_capped' }) },
    ]);
  });

  it('leaves a call inside the window alone', async () => {
    const wire = fakeSocket();
    const recorder = fakeRecorder();
    const session = createRelaySession({
      socket: wire.socket,
      token: mintRelayToken(TICKET, NOW),
      turn: { respond: vi.fn(async () => 'spoke' as const) },
      recorder,
      claimCall: fakeClaims().claimCall,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      now: () => NOW,
    });

    await session.handleMessage(setupFrame());
    await vi.advanceTimersByTimeAsync(CALL_CAP_MS - 1000);

    expect(wire.sent).toEqual([]);
    expect(recorder.callEnded).not.toHaveBeenCalled();
  });

  it('stops the clock when the caller hangs up first', async () => {
    const wire = fakeSocket();
    const recorder = fakeRecorder();
    const session = createRelaySession({
      socket: wire.socket,
      token: mintRelayToken(TICKET, NOW),
      turn: { respond: vi.fn(async () => 'spoke' as const) },
      recorder,
      claimCall: fakeClaims().claimCall,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      now: () => NOW,
    });

    await session.handleMessage(setupFrame());
    await session.handleClose();
    await vi.advanceTimersByTimeAsync(CALL_CAP_MS * 2);

    expect(recorder.callEnded).toHaveBeenCalledTimes(1);
    expect(recorder.callEnded).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' }),
    );
    expect(wire.sent).toEqual([]);
  });
});
