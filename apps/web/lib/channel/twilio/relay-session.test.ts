import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RelaySocket, createRelaySession } from './relay-session';
import { mintRelayToken } from './relay-token';

const KEY = Buffer.alloc(32, 5).toString('base64');
const CALL_SID = 'CA00000000000000000000000000000009';
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
    isClosed: () => closed,
  };
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
  });

  function build(token: string | null, respond = vi.fn(async () => {})) {
    const wire = fakeSocket();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const session = createRelaySession({
      socket: wire.socket,
      token,
      turn: { respond },
      log,
      now: () => NOW,
    });
    return { ...wire, session, log, respond };
  }

  it('answers a prompt once the ticket has been checked, streaming to a final token', async () => {
    const respond = vi.fn(async (_input, emit: (token: string) => void) => {
      emit('Swim is ');
      emit('Thursday.');
    });
    const t = build(mintRelayToken(TICKET, NOW), respond);

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(respond).toHaveBeenCalledWith(
      { prompt: 'when is swim', ticket: TICKET },
      expect.any(Function),
    );
    expect(t.frames()).toEqual([
      { type: 'text', token: 'Swim is ', last: false },
      { type: 'text', token: 'Thursday.', last: false },
      { type: 'text', token: '', last: true },
    ]);
  });

  it('refuses a forged connect BEFORE anything is asked of it — no turn is composed', async () => {
    const t = build('nonsense');

    await t.session.handleMessage(setupFrame());
    await t.session.handleMessage(promptFrame('when is swim'));

    expect(t.respond).not.toHaveBeenCalled();
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
    });
    const t = build(mintRelayToken(TICKET, NOW), respond);

    await t.session.handleMessage(setupFrame());
    await Promise.all([
      t.session.handleMessage(promptFrame('first')),
      t.session.handleMessage(promptFrame('second')),
    ]);

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('never lets a broken turn take the call down silently', async () => {
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
    // The caller hears a closing token rather than dead air.
    expect(t.frames().at(-1)).toEqual({ type: 'text', token: '', last: true });
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
