import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendReplyAsVoiceMemo } from './voice-reply';

const base = {
  text: 'a written reply',
  modelChoseVoice: true,
  isGroup: false,
  textOnly: false,
  chatId: 'chat-1',
  address: '+14375550101',
};

function deps(over: Partial<Parameters<typeof sendReplyAsVoiceMemo>[1]> = {}) {
  return {
    tts: vi.fn(async () => new Uint8Array([1, 2, 3])),
    host: vi.fn(async () => 'https://cdn.test/memo.m4a'),
    capability: vi.fn(async () => ({
      status: 'available' as const,
      selectedService: 'iMessage',
      cached: false,
    })),
    send: vi.fn(async () => ({ providerMessageId: 'm1' })),
    ...over,
  };
}

beforeEach(() => vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

describe('sendReplyAsVoiceMemo (VIL-476 Design lock)', () => {
  it('sends the written reply as one voice memo when every gate holds', async () => {
    const d = deps();
    expect(await sendReplyAsVoiceMemo(base, d)).toEqual({
      sent: 'voice_memo',
      providerMessageId: 'm1',
    });
    expect(d.tts).toHaveBeenCalledWith('a written reply');
    expect(d.send).toHaveBeenCalledWith({
      chatId: 'chat-1',
      audio: { url: 'https://cdn.test/memo.m4a' },
    });
  });

  it.each([
    ['dark', () => vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', ''), {}],
    ['not_chosen', () => {}, { modelChoseVoice: false }],
    ['not_one_to_one', () => {}, { isGroup: true }],
    ['not_one_to_one', () => {}, { chatId: null }],
    ['text_only_turn', () => {}, { textOnly: true }],
  ])('stays text: %s', async (why, setup, over) => {
    setup();
    const d = deps();
    expect(await sendReplyAsVoiceMemo({ ...base, ...over }, d)).toEqual({ sent: 'text', why });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.tts).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'not_available', selectedService: 'SMS', cached: false }],
    [{ status: 'unknown', reason: 'rate_limited' }],
  ])('capability not available is text, never bare audio', async (cap) => {
    const d = deps({ capability: vi.fn(async () => cap as never) });
    expect(await sendReplyAsVoiceMemo(base, d)).toEqual({ sent: 'text', why: 'capability' });
    expect(d.send).not.toHaveBeenCalled();
  });

  it('TTS failure is text, and nothing is sent', async () => {
    const d = deps({ tts: vi.fn(async () => Promise.reject(new Error('tts down'))) });
    expect(await sendReplyAsVoiceMemo(base, d)).toEqual({ sent: 'text', why: 'tts_failed' });
    expect(d.send).not.toHaveBeenCalled();
  });

  it('a failed send is text', async () => {
    const d = deps({ send: vi.fn(async () => Promise.reject(new Error('x'))) });
    expect(await sendReplyAsVoiceMemo(base, d)).toEqual({ sent: 'text', why: 'send_failed' });
  });
});
