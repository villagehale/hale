import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildGenerationProperties,
  hashLlmFamilyId,
  llmContentCaptureEnabled,
  llmDeployEnv,
  redactLlmPii,
  serializeAiInput,
  serializeAiOutput,
} from './llm-analytics.js';
import { SONNET_MODEL } from './model.js';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const SALT = 'posthog-id-salt-test';

describe('redactLlmPii', () => {
  it('redacts email, phone, and street address, leaving the rest', () => {
    const raw = 'Call +1 (416) 555-0199 or write parent@example.com at 12 Maple Street about swim.';
    const redacted = redactLlmPii(raw);
    expect(redacted).toContain('[phone]');
    expect(redacted).toContain('[email]');
    expect(redacted).toContain('[address]');
    expect(redacted).toContain('swim');
    expect(redacted).not.toContain('416');
    expect(redacted).not.toContain('parent@example.com');
    expect(redacted).not.toContain('Maple');
  });
});

describe('hashLlmFamilyId', () => {
  it('is HMAC-SHA256 of the family id and never the raw id', () => {
    const hashed = hashLlmFamilyId(FAMILY, SALT);
    expect(hashed).toBe(createHmac('sha256', SALT).update(FAMILY).digest('hex'));
    expect(hashed).not.toContain(FAMILY);
  });

  it('returns null without a salt so callers can fall back to system', () => {
    expect(hashLlmFamilyId(FAMILY, undefined)).toBeNull();
    expect(hashLlmFamilyId(FAMILY, '')).toBeNull();
  });
});

describe('flags', () => {
  it('content capture is off unless the value is exactly true', () => {
    expect(llmContentCaptureEnabled({})).toBe(false);
    expect(llmContentCaptureEnabled({ POSTHOG_LLM_CONTENT_ENABLED: '1' })).toBe(false);
    expect(llmContentCaptureEnabled({ POSTHOG_LLM_CONTENT_ENABLED: 'true' })).toBe(true);
  });

  it('maps Vercel production to prod and everything else to preview', () => {
    expect(llmDeployEnv({ VERCEL_ENV: 'production' })).toBe('prod');
    expect(llmDeployEnv({ VERCEL_ENV: 'preview' })).toBe('preview');
    expect(llmDeployEnv({})).toBe('preview');
  });
});

describe('buildGenerationProperties', () => {
  it('prices tokens, reports cache hit rate, and keeps content off by default', () => {
    const props = buildGenerationProperties({
      ctx: { stage: 'coach', env: 'prod' },
      model: SONNET_MODEL,
      latencyMs: 1500,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      },
      spanId: 'span-1',
    });
    expect(props).toMatchObject({
      $ai_provider: 'anthropic',
      $ai_model: SONNET_MODEL,
      $ai_latency: 1.5,
      $ai_span_id: 'span-1',
      $ai_input_tokens: 10,
      $ai_output_tokens: 20,
      $ai_cache_read_input_tokens: 80,
      $ai_cache_creation_input_tokens: 10,
      hale_cache_hit_rate: 0.8,
      hale_stage: 'coach',
      env: 'prod',
      privacy_mode: true,
      $ai_cache_reporting_exclusive: true,
    });
    expect(typeof props.$ai_total_cost_usd).toBe('number');
    expect(props).not.toHaveProperty('$ai_input');
    expect(props).not.toHaveProperty('$ai_output_choices');
  });

  it('attaches redacted content only when the flag is on', () => {
    const props = buildGenerationProperties({
      ctx: { stage: 'reviewer' },
      model: SONNET_MODEL,
      latencyMs: 100,
      contentEnabled: true,
      request: {
        system: 'Write parent@example.com',
        messages: [{ role: 'user', content: 'Meet at 9 Oak Avenue' }],
      },
      response: { content: [{ type: 'text', text: 'Call +1 514-555-0100' }] },
    });
    expect(props.privacy_mode).toBe(false);
    const input = JSON.stringify(props.$ai_input);
    const output = JSON.stringify(props.$ai_output_choices);
    expect(input).toContain('[email]');
    expect(input).toContain('[address]');
    expect(input).not.toContain('parent@example.com');
    expect(output).toContain('[phone]');
    expect(output).not.toContain('514');
  });

  it('omits cost when the model is not in the table rather than throwing', () => {
    const props = buildGenerationProperties({
      ctx: {},
      model: 'mystery-model',
      latencyMs: 10,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(props).not.toHaveProperty('$ai_total_cost_usd');
    expect(props.hale_stage).toBe('unattributed');
  });
});

describe('serialize helpers', () => {
  it('keeps roles and redacts bodies', () => {
    expect(
      serializeAiInput({ system: 'a@b.co', messages: [{ role: 'user', content: 'hi' }] }),
    ).toEqual([
      { role: 'system', content: '[email]' },
      { role: 'user', content: 'hi' },
    ]);
    expect(serializeAiOutput({ content: 'ok' })).toEqual([{ role: 'assistant', content: 'ok' }]);
  });
});
