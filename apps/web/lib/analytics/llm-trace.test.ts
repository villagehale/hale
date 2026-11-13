import { createHmac } from 'node:crypto';
import type { PostHog } from 'posthog-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGenerationProperties,
  llmFamilyContext,
  traceAnthropic,
  withLlmContext,
} from './llm-trace';
import { resetPosthogClientsForTests } from './posthog-node';

/**
 * LLM tracing. Default is privacy mode (no prompt/completion on the wire). Content
 * capture is a separate flag and redacts PII before send.
 */

const PROMPT_MARKER = 'prompt-marker-7f3a';
const REPLY_MARKER = 'reply-marker-91bc';
const EMAIL_MARKER = 'parent@example.com';

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

describe('with a key: one $ai_generation per call, privacy mode by default', () => {
  it('reports model, tokens, latency, stage — and never the prompt or the completion', async () => {
    const client = fakeAnthropic();
    const ph = fakePosthog();
    const traced = traceAnthropic(client, { stage: 'coach' }, ph.client);
    const res = await traced.messages.create(params as never);
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
      env: 'preview',
    });
    expect(typeof sent.properties.$ai_span_id).toBe('string');
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

  it('a PostHog capture throw does not reject the model call', async () => {
    const client = fakeAnthropic();
    const ph = {
      capture: vi.fn(() => {
        throw new Error('posthog down');
      }),
      flush: vi.fn(async () => {
        throw new Error('flush down');
      }),
    } as unknown as PostHog;
    const traced = traceAnthropic(client, { stage: 'coach' }, ph);
    await expect(traced.messages.create(params as never)).resolves.toMatchObject({ id: 'msg_1' });
  });
});

describe('content capture behind POSTHOG_LLM_CONTENT_ENABLED', () => {
  it('sends redacted prompt and completion when the flag is exactly true', async () => {
    vi.stubEnv('POSTHOG_LLM_CONTENT_ENABLED', 'true');
    const client = fakeAnthropic();
    const ph = fakePosthog();
    const traced = traceAnthropic(client, { stage: 'coach' }, ph.client);
    await traced.messages.create({
      model: 'claude-x',
      system: `Email ${EMAIL_MARKER}`,
      messages: [{ role: 'user', content: 'Call +1 (416) 555-0199 at 12 Maple Street' }],
    } as never);
    await vi.waitFor(() => expect(ph.capture).toHaveBeenCalledTimes(1));
    const sent = ph.capture.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(sent.properties.privacy_mode).toBe(false);
    expect(sent.properties).toHaveProperty('$ai_input');
    expect(sent.properties).toHaveProperty('$ai_output_choices');
    const wire = JSON.stringify(sent);
    expect(wire).toContain('[email]');
    expect(wire).toContain('[phone]');
    expect(wire).toContain('[address]');
    expect(wire).not.toContain(EMAIL_MARKER);
    expect(wire).not.toContain('416');
    expect(wire).not.toContain('Maple');
  });

  it('omitContent keeps $ai_input off even when content capture is on', async () => {
    vi.stubEnv('POSTHOG_LLM_CONTENT_ENABLED', 'true');
    const client = fakeAnthropic();
    const ph = fakePosthog();
    const traced = traceAnthropic(client, { stage: 'notice' }, ph.client);
    const secret = 'SECRET_EMAIL_BODY_7f3a';
    await withLlmContext({ stage: 'notice', omitContent: true }, () =>
      traced.messages.create({
        model: 'claude-x',
        system: secret,
        messages: [{ role: 'user', content: secret }],
      } as never),
    );
    await vi.waitFor(() => expect(ph.capture).toHaveBeenCalledTimes(1));
    const sent = ph.capture.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(sent.properties).not.toHaveProperty('$ai_input');
    expect(sent.properties).not.toHaveProperty('$ai_output_choices');
    expect(JSON.stringify(sent)).not.toContain(secret);
  });
});

describe('llmFamilyContext', () => {
  it('HMACs the family id and never returns the raw id', () => {
    vi.stubEnv('POSTHOG_ID_SALT', 's');
    const familyId = 'fam-raw-id';
    const ctx = llmFamilyContext(familyId);
    expect(ctx.distinctId).toBe(createHmac('sha256', 's').update(familyId).digest('hex'));
    expect(JSON.stringify(ctx)).not.toContain(familyId);
  });

  it('omits distinctId when the salt is unset', () => {
    vi.stubEnv('POSTHOG_ID_SALT', '');
    expect(llmFamilyContext('fam-raw-id')).toEqual({});
  });
});

describe('buildGenerationProperties', () => {
  it('keeps content off the wire in privacy mode', () => {
    const props = buildGenerationProperties({
      ctx: { stage: 'triage' },
      model: 'm',
      latencyMs: 1500,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(props.$ai_latency).toBe(1.5);
    expect(props.privacy_mode).toBe(true);
    expect(props).not.toHaveProperty('$ai_input');
    expect(props).not.toHaveProperty('$ai_output_choices');
  });

  it('reports cache hit rate from the three token fields', () => {
    const props = buildGenerationProperties({
      ctx: { stage: 'coach' },
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
});
