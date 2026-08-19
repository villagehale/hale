import { describe, expect, it } from 'vitest';
import {
  endSession,
  parseRelayMessage,
  spokenBeforeInterrupt,
  textToken,
} from './relay-protocol';

describe('parseRelayMessage', () => {
  it('reads a setup message — the only one that says whose call this is', () => {
    expect(
      parseRelayMessage(
        JSON.stringify({
          type: 'setup',
          sessionId: 'VX0000',
          callSid: 'CA0001',
          from: '+18005550100',
          to: '+18005550101',
          direction: 'inbound',
        }),
      ),
    ).toEqual({ type: 'setup', callSid: 'CA0001' });
  });

  it('reads a prompt, carrying whether the caller has finished speaking', () => {
    expect(
      parseRelayMessage(
        JSON.stringify({ type: 'prompt', voicePrompt: 'when is swim', lang: 'en-US', last: true }),
      ),
    ).toEqual({ type: 'prompt', voicePrompt: 'when is swim', last: true });
    expect(
      parseRelayMessage(
        JSON.stringify({ type: 'prompt', voicePrompt: 'when is', lang: 'en-US', last: false }),
      ),
    ).toEqual({ type: 'prompt', voicePrompt: 'when is', last: false });
  });

  it('reads an interrupt, carrying how much of Hale the caller actually heard', () => {
    expect(
      parseRelayMessage(
        JSON.stringify({
          type: 'interrupt',
          utteranceUntilInterrupt: 'Swim is Thursday at',
          durationUntilInterruptMs: 460,
        }),
      ),
    ).toEqual({ type: 'interrupt', utteranceUntilInterrupt: 'Swim is Thursday at' });
  });

  it('reads dtmf and error', () => {
    expect(parseRelayMessage(JSON.stringify({ type: 'dtmf', digit: '1' }))).toEqual({
      type: 'dtmf',
      digit: '1',
    });
    expect(
      parseRelayMessage(JSON.stringify({ type: 'error', description: 'Invalid message' })),
    ).toEqual({ type: 'error', description: 'Invalid message' });
  });

  it('names a message type it does not act on rather than dropping it', () => {
    expect(parseRelayMessage(JSON.stringify({ type: 'info', foo: 'bar' }))).toEqual({
      type: 'other',
      messageType: 'info',
    });
  });

  it('names garbage as garbage — a socket that cannot parse must not look idle', () => {
    expect(parseRelayMessage('not json')).toEqual({ type: 'unparseable' });
    expect(parseRelayMessage('[]')).toEqual({ type: 'unparseable' });
    expect(parseRelayMessage(JSON.stringify({ type: 'setup' }))).toEqual({ type: 'unparseable' });
    expect(parseRelayMessage(JSON.stringify({ type: 'prompt', last: true }))).toEqual({
      type: 'unparseable',
    });
  });
});

describe('outbound frames', () => {
  it('streams a token that is not the last one', () => {
    expect(JSON.parse(textToken('Swim is ', false))).toEqual({
      type: 'text',
      token: 'Swim is ',
      last: false,
    });
  });

  it('marks the final token, which is what makes Twilio stop waiting', () => {
    expect(JSON.parse(textToken('Thursday.', true))).toEqual({
      type: 'text',
      token: 'Thursday.',
      last: true,
    });
  });

  it('ends the session with a reason an operator can read back', () => {
    expect(JSON.parse(endSession('unauthorized'))).toEqual({
      type: 'end',
      handoffData: JSON.stringify({ reasonCode: 'unauthorized' }),
    });
  });
});

describe('spokenBeforeInterrupt', () => {
  it('keeps only what the caller heard, so the thread records the real conversation', () => {
    expect(spokenBeforeInterrupt('Swim is Thursday at 5:15 at the Y.', 'Swim is Thursday at')).toBe(
      'Swim is Thursday at',
    );
  });

  it('falls back to the full turn when Twilio reports no partial utterance', () => {
    expect(spokenBeforeInterrupt('Swim is Thursday.', '')).toBe('Swim is Thursday.');
  });
});
