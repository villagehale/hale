import type { PostHog } from 'posthog-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGenerationProperties, traceAnthropic, withLlmContext } from './llm-trace';
import { resetPosthogClientsForTests } from './posthog-node';

/**
 * LLM tracing in PRIVACY MODE. The assertions are on structure — which keys leave —
 * never on the wording of any prompt or reply.
 */

const PROMPT_MARKER = 'prompt-marker-7f3a';
const REPLY_MARKER = 'reply-marker-91bc';

function fakeAnthropic() {
  const create = vi.fn(async (_params: unknown) => ({
    id: 'msg_1',
    model: 'claude-x',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: REPLY_MARKER }],
    usage: { input_tokens: 12, output_tokens: 34 },
  }));
  const finalMessage = vi.fn(async () => ({
    model: 'claude-x',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: REPLY_MARKER }],
    usage: { input_tokens: 5, output_tokens: 6 },
  }));
  const stream = vi.fn((_params: unknown) => ({ finalMessage }));
  return { messages: { create, stream }, other: 'kept' };
}

function fakePosthog() {
  const capture = vi.fn();
  return {
    client: { capture, flush: vi.fn(async () => {}) } as unknown as PostHog,
    capture,
  };
}

const params = {
  model: 'claude-x',
  max_tokens: 10,
  system: PROMPT_MARKER,
  messages: [{ role: 'user', content: PROMPT_MARKER }],
};

afterEach(() => {
  vi.unstubAllEnvs();
  resetPosthogClientsForTests();
});

describe('inert without POSTHOG_PROJECT_API_KEY', () => {
  it('returns the very same client object — no proxy, no capture', async () => {
    vi.stubEnv('POSTHOG_PROJECT_API_KEY', '');
    resetPosthogClientsForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = fakeAnthropic();
    const traced = traceAnthropic(client);
    expect(traced).toBe(client);
    await traced.messages.create(params as never);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('with a key: one $ai_generation per call, privacy mode', () => {
  it('reports model, tokens, latency, stage — and never the prompt or the completion', async () => {
    const client = fakeAnthropic();
    const ph = fakePosthog();
    const traced = traceAnthropic(client, { stage: 'coach' }, ph.client);
    const res = await traced.messages.create(params as never);
    // The caller still gets the real response.
    expect((res as { id: string }).id).toBe('msg_1');
    await vi.waitFor(() => expect(ph.capture).toHaveBeenCalledTimes(1));
    const sent = ph.capture.mock.calls[0]?.[0] as {
      event: string;
      distinctId: string;
      properties: Record<string, unknown>;
    };
    expect(sent.event).toBe('$ai_generation');
    expect(sent.distinctId).toBe('system');
    expect(sent.properties).toMatchObject({
      $ai_provider: 'anthropic',
      $ai_model: 'claude-x',
      $ai_input_tokens: 12,
      $ai_output_tokens: 34,
      $ai_is_error: false,
      hale_stage: 'coach',
      privacy_mode: true,
    });
    expect(sent.properties).not.toHaveProperty('$ai_input');
    expect(sent.properties).not.toHaveProperty('$ai_output_choices');
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(PROMPT_MARKER);
    expect(wire).not.toContain(REPLY_MARKER);
  });

  it('takes distinct id, trace id and stage from the surrounding context', async () => {
    const ph = fakePosthog();
    const traced = traceAnthropic(fakeAnthropic(), {}, ph.client);
    await withLlmContext(
      { distinctId: 'fam_hash_1', traceId: 'run-1', stage: 'reviewer', channel: 'sms' },
      () => traced.messages.create(params as never),
    );
    await vi.waitFor(() => expect(ph.capture).toHaveBeenCalledTimes(1));
    const sent = ph.capture.mock.calls[0]?.[0] as {
      distinctId: string;
      properties: Record<string, unknown>;
    };
    expect(sent.distinctId).toBe('fam_hash_1');
    expect(sent.properties).toMatchObject({
      $ai_trace_id: 'run-1',
      hale_stage: 'reviewer',
      channel: 'sms',
    });
  });

  it('traces messages.stream through finalMessage', async () => {
    const ph = fakePosthog();
    const traced = traceAnthropic(fakeAnthropic(), { stage: 'discovery' }, ph.client);
    await (
      traced.messages.stream(params as never) as { finalMessage: () => Promise<unknown> }
    ).finalMessage();
    await vi.waitFor(() => expect(ph.capture).toHaveBeenCalledTimes(1));
    const sent = ph.capture.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(sent.properties).toMatchObject({ $ai_input_tokens: 5, hale_stage: 'discovery' });
    expect(JSON.stringify(sent)).not.toContain(REPLY_MARKER);
  });

  it('reports a failed call by class and status only, and still throws to the caller', async () => {
    const client = fakeAnthropic();
    const failure = Object.assign(new Error(`upstream echoed ${PROMPT_MARKER}`), {
      name: 'RateLimitError',
      status: 429,
    });
    client.messages.create.mockRejectedValueOnce(failure);
    const ph = fakePosthog();
    const traced = traceAnthropic(client, {}, ph.client);
    await expect(traced.messages.create(params as never)).rejects.toBe(failure);
    await vi.waitFor(() => expect(ph.capture).toHaveBeenCalledTimes(1));
    const sent = ph.capture.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(sent.properties).toMatchObject({
      $ai_is_error: true,
      $ai_error: 'RateLimitError',
      $ai_http_status: 429,
      hale_stage: 'unattributed',
    });
    expect(JSON.stringify(sent)).not.toContain(PROMPT_MARKER);
  });

  it('leaves every other client member alone', () => {
    const ph = fakePosthog();
    const traced = traceAnthropic(fakeAnthropic(), {}, ph.client);
    expect(traced.other).toBe('kept');
  });
});

describe('buildGenerationProperties', () => {
  it('has no field a prompt or completion could ride in', () => {
    const props = buildGenerationProperties({
      ctx: { stage: 'triage' },
      model: 'm',
      latencyMs: 1500,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(Object.keys(props).sort()).toEqual(
      [
        '$ai_input_tokens',
        '$ai_is_error',
        '$ai_latency',
        '$ai_model',
        '$ai_output_tokens',
        '$ai_provider',
        '$ai_trace_id',
        'hale_stage',
        'privacy_mode',
      ].sort(),
    );
    expect(props.$ai_latency).toBe(1.5);
  });
});
