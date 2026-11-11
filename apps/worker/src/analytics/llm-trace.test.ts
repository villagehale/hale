import type { PostHog } from 'posthog-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureSafeException } from './exceptions.js';
import {
  buildGenerationProperties,
  llmFamilyContext,
  traceAnthropic,
  withLlmContext,
} from './llm-trace.js';
import { projectClient, resetPosthogClientForTests } from './posthog.js';

const MARKER = 'worker-marker-44e1';
const EMAIL = 'parent@example.com';

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

  it('inherits hashed family and eval tags from context', async () => {
    const capture = vi.fn();
    const ph = { capture, flush: vi.fn(async () => {}) } as unknown as PostHog;
    const traced = traceAnthropic(fakeAnthropic(), {}, ph);
    await withLlmContext(
      { distinctId: 'hashed', env: 'eval', suite: 'classifier', caseName: 'fx-1', cached: true },
      () => traced.messages.create({ model: 'claude-x' } as never),
    );
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const sent = capture.mock.calls[0]?.[0] as {
      distinctId: string;
      properties: Record<string, unknown>;
    };
    expect(sent.distinctId).toBe('hashed');
    expect(sent.properties).toMatchObject({
      env: 'eval',
      hale_eval_suite: 'classifier',
      hale_eval_case: 'fx-1',
      cached: true,
    });
  });

  it('redacts content when the flag is on', async () => {
    vi.stubEnv('POSTHOG_LLM_CONTENT_ENABLED', 'true');
    const capture = vi.fn();
    const ph = { capture, flush: vi.fn(async () => {}) } as unknown as PostHog;
    const traced = traceAnthropic(fakeAnthropic(), { stage: 'drafter' }, ph);
    await traced.messages.create({
      model: 'claude-x',
      messages: [{ role: 'user', content: `write ${EMAIL}` }],
    } as never);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const wire = JSON.stringify(capture.mock.calls[0]?.[0]);
    expect(wire).toContain('[email]');
    expect(wire).not.toContain(EMAIL);
  });

  it('omitContent keeps $ai_input off even when content capture is on', async () => {
    vi.stubEnv('POSTHOG_LLM_CONTENT_ENABLED', 'true');
    const capture = vi.fn();
    const ph = { capture, flush: vi.fn(async () => {}) } as unknown as PostHog;
    const traced = traceAnthropic(fakeAnthropic(), { stage: 'notice' }, ph);
    const secret = 'SECRET_EMAIL_BODY_7f3a';
    await withLlmContext({ stage: 'notice', omitContent: true }, () =>
      traced.messages.create({
        model: 'claude-x',
        messages: [{ role: 'user', content: secret }],
      } as never),
    );
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const sent = capture.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(sent.properties).not.toHaveProperty('$ai_input');
    expect(JSON.stringify(sent)).not.toContain(secret);
  });

  it('reports cache hit rate from the three token fields', () => {
    const props = buildGenerationProperties({
      ctx: { stage: 'reviewer' },
      model: 'm',
      latencyMs: 100,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      },
    });
    expect(props.$ai_cache_read_input_tokens).toBe(80);
    expect(props.$ai_cache_creation_input_tokens).toBe(10);
    expect(props.$ai_input_tokens).toBe(10);
    expect(props.hale_cache_hit_rate).toBe(0.8);
  });

  it('does not hash a family id without a salt', () => {
    vi.stubEnv('POSTHOG_ID_SALT', '');
    expect(llmFamilyContext('raw-family')).toEqual({});
  });
});
