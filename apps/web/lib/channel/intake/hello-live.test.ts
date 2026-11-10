import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { type FriendVoiceInput, createFriendVoiceComposer, speakFriend } from './friend-voice';

/**
 * #868 recording: the four first-touch hellos (EN / FR / ZH / AR), real model, judged
 * and retried exactly as production speaks. Gated, because it calls Anthropic, and
 * every call goes through the shared spend ledger with a hard cap:
 *
 *   cd apps/web && LIVE=1 HALE_LLM_NO_STREAM=1 HALE_LEDGER=/tmp/r868-ledger.json \
 *     HALE_MAX_USD=4 pnpm exec vitest run lib/channel/intake/hello-live.test.ts
 *
 * Output: HELLO_OUT (default /tmp/r868-hellos.json), for the screenshot render.
 */

const LIVE = process.env.LIVE === '1' && Boolean(process.env.ANTHROPIC_API_KEY);
const PRICE: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5': { input: 3, output: 15 },
};

function ledgered<C extends { messages: { create: (...a: never[]) => unknown } }>(client: C): C {
  const path = process.env.HALE_LEDGER;
  const cap = Number(process.env.HALE_MAX_USD);
  if (!path || !Number.isFinite(cap))
    throw new Error('hello-live: HALE_LEDGER and HALE_MAX_USD are required');
  const create = client.messages.create.bind(client.messages) as unknown as (
    r: Record<string, unknown>,
    ...rest: unknown[]
  ) => Promise<{ usage?: Record<string, number> }>;
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { capUsd: cap, totalUsd: 0, calls: [] };
    }
  };
  (client.messages as unknown as { create: unknown }).create = async (
    request: Record<string, unknown>,
    ...rest: unknown[]
  ) => {
    const model = String(request.model).replace(/-\d{8}$/, '');
    const p = PRICE[model];
    if (!p) throw new Error(`hello-live: no price for ${model}; refusing`);
    const inChars = JSON.stringify([
      request.system ?? '',
      request.messages,
      request.tools ?? [],
    ]).length;
    const worst = ((inChars / 3) * p.input + Number(request.max_tokens ?? 4096) * p.output) / 1e6;
    if (read().totalUsd + worst > cap)
      throw new Error('hello-live: ledger cap would be passed - stopped');
    const response = await create(request, ...rest);
    const u = response.usage ?? {};
    const usd =
      (((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) * p.input +
        (u.output_tokens ?? 0) * p.output) /
      1e6;
    const after = read();
    after.totalUsd += usd;
    after.calls.push({ at: new Date().toISOString(), model, usd, tag: 'hello' });
    writeFileSync(path, JSON.stringify(after, null, 2));
    return response;
  };
  return client;
}

const HELLOS = [
  { id: 'en', parentWords: 'hi', language: 'en' },
  { id: 'fr', parentWords: 'bonjour', language: 'fr' },
  { id: 'zh', parentWords: '你好', language: 'zh' },
  { id: 'ar', parentWords: 'مرحبا', language: 'ar' },
] as const;

function input(hello: (typeof HELLOS)[number]): FriendVoiceInput {
  return {
    step: 'place',
    language: hello.language,
    address: 'tu',
    introduce: true,
    parentWords: hello.parentWords,
    recentTurns: [],
    placeLabel: null,
    agesLabel: null,
    ageMonths: [],
    findLines: [],
    listKind: 'none',
    activity: null,
    day: null,
    parentName: null,
  };
}

describe.skipIf(!LIVE)('#868 first-touch hellos (real model)', () => {
  it('writes the four hellos', async () => {
    const composer = createFriendVoiceComposer(
      // Native fetch: the SDK's bundled fetch breaks on the recording box's egress proxy.
      ledgered(
        budgetedAnthropic({ ...HOT_SMS_CLIENT_OPTIONS, fetch: globalThis.fetch } as never) as never,
      ),
    );
    const out: Record<string, { body: string; source: string }> = {};
    for (const hello of HELLOS) {
      const spoken = await speakFriend(composer, input(hello));
      out[hello.id] = { body: spoken.body, source: spoken.source };
      console.info(`HELLO ${hello.id} [${spoken.source}]: ${spoken.body}`);
    }
    writeFileSync(process.env.HELLO_OUT ?? '/tmp/r868-hellos.json', JSON.stringify(out, null, 2));
    expect(Object.keys(out)).toHaveLength(4);
  }, 300_000);
});
