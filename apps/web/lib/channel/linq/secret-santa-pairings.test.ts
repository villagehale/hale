import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PostHog } from 'posthog-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceAnthropic } from '~/lib/analytics/llm-trace';
import { resetPosthogClientsForTests } from '~/lib/analytics/posthog-node';
import type { Database } from '@hale/db';
import { SECRET_SANTA_LINE_TOOL, createSecretSantaLineWriter } from './secret-santa';
import { drawDerangement, writePairings } from './secret-santa-pairings';

/**
 * VIL-686 — the draw itself, and the structural leak guards that do not need a database.
 */

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, '0')}`);

describe('drawDerangement', () => {
  it('never has a fixed point and is always a bijection, for 4 to 30 people', () => {
    for (let n = 4; n <= 30; n += 1) {
      const people = ids(n);
      for (let run = 0; run < 400; run += 1) {
        const out = drawDerangement(people);
        expect(out.every((receiver, i) => receiver !== people[i])).toBe(true);
        expect([...out].sort()).toEqual(people);
      }
    }
  });

  it('refuses fewer than four people', () => {
    expect(() => drawDerangement(ids(3))).toThrow(/four/);
  });

  it('is roughly uniform over the nine derangements of four', () => {
    const people = ids(4);
    const counts = new Map<string, number>();
    const runs = 9000;
    for (let i = 0; i < runs; i += 1) {
      const key = drawDerangement(people).join(',');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(9);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(runs / 9 - 300);
      expect(count).toBeLessThan(runs / 9 + 300);
    }
  });
});

describe('writePairings', () => {
  it('writes every pointer in one statement, givers in ascending id order', async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
    const execute = vi.fn(async (_query: SQL) => ({ rows: [] }));
    const givers = ['c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002'];
    await writePairings({ execute } as unknown as Database, 'draw-1', givers);
    expect(execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0] as SQL);
    const giverParams = query.params.filter((p) => typeof p === 'string' && givers.includes(p));
    expect(giverParams).toEqual([...givers].sort());
    // Each pointer is ciphertext: no giver or receiver id rides in the clear beside it.
    const pointers = query.params.filter(
      (p) => typeof p === 'string' && !givers.includes(p) && p !== 'draw-1',
    );
    expect(pointers).toHaveLength(4);
    for (const pointer of pointers) for (const id of givers) expect(pointer).not.toContain(id);
  });
});

describe('PostHog never sees a draw', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPosthogClientsForTests();
  });

  function fakeClient(text: string) {
    const response = {
      id: 'msg_1',
      model: 'claude-x',
      stop_reason: 'tool_use',
      // Whichever shape the lane asks for: a tool call, or JSON output.
      content: [
        { type: 'tool_use', id: 'tu_1', name: SECRET_SANTA_LINE_TOOL, input: { text } },
        { type: 'text', text: JSON.stringify({ text }) },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    return {
      messages: {
        create: vi.fn(async (_params: unknown) => response),
        stream: vi.fn((_params: unknown) => ({ finalMessage: async () => response })),
      },
    };
  }

  function fakePosthog() {
    const capture = vi.fn();
    return { client: { capture, flush: vi.fn(async () => {}) } as unknown as PostHog, capture };
  }

  it("a giver's draft is traced with no content even when content capture is on", async () => {
    vi.stubEnv('POSTHOG_LLM_CONTENT_ENABLED', 'true');
    const ph = fakePosthog();
    const client = traceAnthropic(fakeClient('Hi Mei! You have Zebulon.'), { stage: 'group' }, ph.client);
    const writer = createSecretSantaLineWriter(() => client as never);
    const text = await writer.write({
      purpose: 'giver_draw',
      language: 'en',
      facts: { giver: 'Mei', receiver: 'Zebulon', firstOneToOne: false, mayNotBeHaleFamily: false },
      verbatim: ['Zebulon'],
    });
    expect(text).toBe('Hi Mei! You have Zebulon.');
    await vi.waitFor(() => expect(ph.capture).toHaveBeenCalled());
    expect(JSON.stringify(ph.capture.mock.calls)).not.toContain('Zebulon');
  });

  it('positive control: the same traced client outside the writer does carry the name', async () => {
    vi.stubEnv('POSTHOG_LLM_CONTENT_ENABLED', 'true');
    const ph = fakePosthog();
    const client = traceAnthropic(fakeClient('Hi Mei! You have Zebulon.'), { stage: 'group' }, ph.client);
    await client.messages.create({
      model: 'claude-x',
      messages: [{ role: 'user', content: 'giver Mei receiver Zebulon' }],
    } as never);
    await vi.waitFor(() => expect(ph.capture).toHaveBeenCalled());
    expect(JSON.stringify(ph.capture.mock.calls)).toContain('Zebulon');
  });
});

describe('repo greps: who may touch the pairing', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  /** Production files (tests excluded) matching `pattern`, as repo paths. */
  function filesMatching(pattern: string): string[] {
    let out = '';
    try {
      out = execFileSync(
        'git',
        ['grep', '--untracked', '-l', '-E', pattern, '--', 'apps', 'packages', ':!*.test.ts', ':!*.test.mjs', ':!**/evals/**'],
        { cwd: root, encoding: 'utf8' },
      );
    } catch (err) {
      if ((err as { status?: number }).status === 1) return [];
      throw err;
    }
    return out.split('\n').filter(Boolean).sort();
  }

  it('the pointer column is named only by the pairing module, its schema and its migration', () => {
    expect(filesMatching('receiverEncrypted|receiver_encrypted')).toEqual([
      'apps/web/lib/channel/linq/secret-santa-pairings.ts',
      'packages/db/drizzle/0245_secret_santa.sql',
      'packages/db/src/schema/secret-santa.ts',
    ]);
  });

  it('no reader outside the Secret Santa modules joins the participants table', () => {
    const readers = filesMatching('secretSantaParticipants|secret_santa_participants').filter(
      (file) => !/apps\/web\/lib\/channel\/linq\/secret-santa[a-z-]*\.ts$/.test(file),
    );
    expect(readers).toEqual([
      'packages/db/drizzle/0245_secret_santa.sql',
      'packages/db/src/schema/secret-santa.ts',
    ]);
    // Positive control: the grep does find the module that owns it.
    expect(filesMatching('secretSantaParticipants')).toContain(
      'apps/web/lib/channel/linq/secret-santa.ts',
    );
  });

  it('no Secret Santa module can fall back to a primary parent', () => {
    expect(
      filesMatching('primaryParentId').filter((file) => file.includes('secret-santa')),
    ).toEqual([]);
    // Positive control: the grep sees the helper where it lives.
    expect(filesMatching('primaryParentId')).toContain('apps/web/lib/channel/linq/multi-family.ts');
  });
});
