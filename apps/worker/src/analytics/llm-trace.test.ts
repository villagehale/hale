import type { PostHog } from 'posthog-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureSafeException } from './exceptions.js';
import { traceAnthropic } from './llm-trace.js';
import { projectClient, resetPosthogClientForTests } from './posthog.js';

const MARKER = 'worker-marker-44e1';

function fakeAnthropic() {
  return {
    messages: {
      create: vi.fn(async (_params: unknown) => ({
        model: 'claude-x',
        content: [{ type: 'text', text: MARKER }],
        usage: { input_tokens: 3, output_tokens: 4 },
      })),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPosthogClientForTests();
});

describe('worker PostHog: inert without POSTHOG_PROJECT_API_KEY', () => {
  it('builds no client, wraps nothing, sends nothing', async () => {
    vi.stubEnv('POSTHOG_PROJECT_API_KEY', '');
    resetPosthogClientForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(projectClient()).toBeNull();
    const client = fakeAnthropic();
    expect(traceAnthropic(client)).toBe(client);
    await expect(
      captureSafeException(new Error(MARKER), 'system', { hale_surface: 'worker' }),
    ).resolves.toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('worker PostHog: privacy mode with a key', () => {
  it('reports tokens and stage, never prompt or completion text', async () => {
    const capture = vi.fn();
    const ph = { capture, flush: vi.fn(async () => {}) } as unknown as PostHog;
    const traced = traceAnthropic(fakeAnthropic(), { stage: 'reviewer' }, ph);
    await traced.messages.create({ model: 'claude-x', messages: [{ content: MARKER }] } as never);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const sent = capture.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(sent.properties).toMatchObject({ hale_stage: 'reviewer', $ai_output_tokens: 4 });
    expect(sent.properties).not.toHaveProperty('$ai_input');
    expect(sent.properties).not.toHaveProperty('$ai_output_choices');
    expect(JSON.stringify(sent)).not.toContain(MARKER);
  });
});
