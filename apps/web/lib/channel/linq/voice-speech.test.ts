import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearForNonAnthropic } from '~/lib/pipeline/provider-clearance';
import { productionVoiceReplyDeps } from './voice-reply';
import {
  HALE_TRANSCRIBE_MODEL,
  HALE_TTS_MODEL,
  HALE_TTS_VOICE,
  VOICE_MEMO_MAX_BYTES,
  VoiceSpeechError,
  hearVoiceMemo,
  synthesizeHaleVoice,
  transcribeVoiceMemo,
} from './voice-speech';

/** VIL-495 · the Gateway wire for Hale's voice and the parent's voice memo. */

const KEY = 'gateway_test_key_not_a_secret';

async function cleared() {
  const decision = await clearForNonAnthropic({ kind: 'parent_text' }, 'test');
  if (!('cleared' in decision)) throw new Error('expected a clearance');
  return decision.cleared;
}

function gateway(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
}

beforeEach(() => vi.stubEnv('AI_GATEWAY_API_KEY', KEY));
afterEach(() => vi.unstubAllEnvs());

describe('synthesizeHaleVoice', () => {
  it("speaks the text in Hale's one voice and decodes the mp3", async () => {
    const f = gateway({ audio: Buffer.from([7, 8, 9]).toString('base64'), warnings: [] });
    const out = await synthesizeHaleVoice(' the reply ', await cleared(), f);
    expect(Array.from(out.audio)).toEqual([7, 8, 9]);
    expect(out.contentType).toBe('audio/mpeg');
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('https://ai-gateway.vercel.sh/v4/ai/speech-model');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['ai-model-id']).toBe(HALE_TTS_MODEL);
    expect(headers['ai-speech-model-specification-version']).toBe('4');
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'the reply',
      voice: HALE_TTS_VOICE,
      outputFormat: 'mp3',
    });
  });

  it('refuses without a minted clearance, before any fetch (VIL-556)', async () => {
    const f = gateway({ audio: 'AA==' });
    const forged = { basis: 'parent_text' } as unknown as Awaited<ReturnType<typeof cleared>>;
    await expect(synthesizeHaleVoice('x', forged, f)).rejects.toThrow('NonGoogleClearance');
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['not_configured', () => vi.stubEnv('AI_GATEWAY_API_KEY', ''), gateway({ audio: 'AA==' })],
    ['http_503', () => {}, gateway({ error: 'down' }, 503)],
    ['no_audio', () => {}, gateway({ audio: '' })],
  ])('names a failure: %s', async (code, setup, f) => {
    setup();
    await expect(synthesizeHaleVoice('x', await cleared(), f)).rejects.toMatchObject({ code });
  });
});

describe('transcribeVoiceMemo', () => {
  it('fetches the memo and returns the Gateway transcript', async () => {
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).startsWith('https://media.test/')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'audio/x-m4a' },
        });
      }
      return new Response(JSON.stringify({ text: '  is swim still on saturday  ' }));
    });
    const text = await transcribeVoiceMemo(
      { url: 'https://media.test/memo.m4a', mime: 'audio/x-m4a' },
      await cleared(),
      f,
    );
    expect(text).toBe('is swim still on saturday');
    const [url, init] = f.mock.calls[1] ?? [];
    expect(url).toBe('https://ai-gateway.vercel.sh/v4/ai/transcription-model');
    const headers = init?.headers as Record<string, string>;
    expect(headers['ai-model-id']).toBe(HALE_TRANSCRIBE_MODEL);
    expect(JSON.parse(String(init?.body))).toEqual({
      audio: Buffer.from([1, 2, 3, 4]).toString('base64'),
      mediaType: 'audio/x-m4a',
    });
  });

  it('an empty transcript is no_speech, an unreachable memo is audio_unreachable', async () => {
    const silent = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith('https://media.test/')
        ? new Response(new Uint8Array([1]))
        : new Response(JSON.stringify({ text: ' ' })),
    );
    await expect(
      transcribeVoiceMemo({ url: 'https://media.test/a', mime: null }, await cleared(), silent),
    ).rejects.toMatchObject({ code: 'no_speech' });
    const gone = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      transcribeVoiceMemo({ url: 'https://media.test/a', mime: null }, await cleared(), gone),
    ).rejects.toMatchObject({ code: 'audio_unreachable' });
    expect(gone).toHaveBeenCalledTimes(1);
  });
});

describe('transcribeVoiceMemo · the size cap holds while reading', () => {
  function streamed(chunks: number, chunkBytes: number) {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunks) return controller.close();
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    });
    return { body, pulled: () => pulled };
  }

  it('a body with no Content-Length over the cap is too_large before it is all read', async () => {
    const chunkBytes = 1_000_000;
    const memo = streamed(VOICE_MEMO_MAX_BYTES / chunkBytes + 20, chunkBytes);
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith('https://media.test/')
        ? new Response(memo.body)
        : new Response(JSON.stringify({ text: 'x' })),
    );
    await expect(
      transcribeVoiceMemo({ url: 'https://media.test/a', mime: null }, await cleared(), f),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(memo.pulled()).toBeLessThanOrEqual(VOICE_MEMO_MAX_BYTES / chunkBytes + 2);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a false small Content-Length does not let a large body through', async () => {
    const memo = streamed(12, 1_000_000);
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith('https://media.test/')
        ? new Response(memo.body, { headers: { 'content-length': '10' } })
        : new Response(JSON.stringify({ text: 'x' })),
    );
    await expect(
      transcribeVoiceMemo({ url: 'https://media.test/a', mime: null }, await cleared(), f),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a streamed body under the cap is transcribed (positive control)', async () => {
    const memo = streamed(3, 1_000);
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).startsWith('https://media.test/')
        ? new Response(memo.body)
        : new Response(JSON.stringify({ text: 'heard' })),
    );
    await expect(
      transcribeVoiceMemo({ url: 'https://media.test/a', mime: null }, await cleared(), f),
    ).resolves.toBe('heard');
    const sent = JSON.parse(String(f.mock.calls[1]?.[1]?.body));
    expect(Buffer.from(sent.audio, 'base64').byteLength).toBe(3_000);
  });
});

describe('hearVoiceMemo · only the parent in their own thread (VIL-495)', () => {
  it('a group-turn memo is not heard and nothing is fetched', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ text: 'x' })));
    await expect(
      hearVoiceMemo({ url: 'https://media.test/a', mime: null }, 'group'),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('a 1:1 memo reaches the transcriber (positive control)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        String(url).startsWith('https://media.test/')
          ? new Response(new Uint8Array([1]))
          : new Response(JSON.stringify({ text: 'on my way' })),
      );
    await expect(
      hearVoiceMemo({ url: 'https://media.test/a', mime: null }, 'direct'),
    ).resolves.toBe('on my way');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });
});

describe('productionVoiceReplyDeps · the reply is family state (VIL-556)', () => {
  function witness(rows: unknown[]): Database {
    return { execute: vi.fn(async () => rows) } as unknown as Database;
  }

  it('a family with a Google connection is refused the Gateway, before any fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const deps = productionVoiceReplyDeps(witness([{ '?column?': 1 }]), 'family-1');
    await expect(deps.tts('a reply')).rejects.toMatchObject({
      code: 'not_cleared:family_has_google_connection',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('a family without one is cleared and reaches the Gateway (positive control)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const deps = productionVoiceReplyDeps(witness([]), 'family-1');
    await expect(deps.tts('a reply')).rejects.toBeInstanceOf(VoiceSpeechError);
    await expect(deps.tts('a reply')).rejects.toMatchObject({ code: 'not_configured' });
  });
});
