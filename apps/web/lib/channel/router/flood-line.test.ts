import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { structuredReply } from '~/lib/testing/structured-reply';

const skillLoad = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('~/lib/cron/skill', async (actual) => {
  const real = await actual<typeof import('~/lib/cron/skill')>();
  return {
    ...real,
    loadCronSkill: async (name: string) => {
      if (skillLoad.error) throw skillLoad.error;
      return real.loadCronSkill(name);
    },
  };
});
import { createFloodLine, floodLineUserMessage } from './flood-line';

/**
 * The over-limit line's request shape and every way it comes back unavailable. What the
 * model WRITES is the eval's job (run-flood-line-eval.mjs); these drive only the code.
 */

function clientSaying(line: string, seen: unknown[] = []): () => AgentClient {
  return () =>
    ({
      messages: {
        create: vi.fn(async (request: unknown) => {
          seen.push(request);
          return structuredReply(request, 'flood_line', { line });
        }),
      },
    }) as unknown as AgentClient;
}

describe('floodLineUserMessage', () => {
  it('carries the situation, where it was written and the language, and nothing else', () => {
    expect(JSON.parse(floodLineUserMessage({ language: 'fr', inGroup: true }))).toEqual({
      situation: 'many_texts_at_once',
      where_they_wrote: 'a group chat',
      where_this_goes: 'only to them, privately',
      language: 'fr',
    });
  });

  it('names their own chat 1:1 and passes a null language through', () => {
    expect(JSON.parse(floodLineUserMessage({ language: null, inGroup: false }))).toEqual({
      situation: 'many_texts_at_once',
      where_they_wrote: 'their own chat with Hale',
      where_this_goes: 'only to them, privately',
      language: null,
    });
  });
});

describe('createFloodLine', () => {
  it('composes a line, flattened to plain text', async () => {
    const seen: unknown[] = [];
    const outcome = await createFloodLine(clientSaying('Swamped — back soon…', seen)).compose({
      language: 'en',
      inGroup: false,
    });
    expect(outcome).toEqual({ status: 'composed', line: 'Swamped - back soon...' });
    expect(seen).toHaveLength(1);
  });

  it('client_unavailable: a client that cannot be built', async () => {
    const outcome = await createFloodLine(() => {
      throw new Error('echo: private text');
    }).compose({ language: 'en', inGroup: true });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'client_unavailable' });
  });

  it('skill_unavailable: the skill does not load, and no model call is made', async () => {
    const seen: unknown[] = [];
    skillLoad.error = new Error('missing');
    try {
      const outcome = await createFloodLine(clientSaying('x', seen)).compose({
        language: 'en',
        inGroup: true,
      });
      expect(outcome).toEqual({ status: 'unavailable', reason: 'skill_unavailable' });
      expect(seen).toEqual([]);
    } finally {
      skillLoad.error = null;
    }
  });

  it('model_failed: the provider throws', async () => {
    const outcome = await createFloodLine(
      () =>
        ({
          messages: {
            create: vi.fn(async () => {
              throw new Error('echo: private text');
            }),
          },
        }) as unknown as AgentClient,
    ).compose({ language: 'en', inGroup: false });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'model_failed' });
  });

  it('empty: the model writes only whitespace', async () => {
    const outcome = await createFloodLine(clientSaying('   ')).compose({
      language: null,
      inGroup: false,
    });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'empty' });
  });
});
