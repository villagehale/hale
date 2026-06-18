import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  upsertMemoryFact,
  appendMemoryEpisode,
  retireMemoryFact,
} from '../services/memory-writer.js';
import { runMemoryInferencer, type MemoryInferencerClient } from './memory-inferencer.js';

/**
 * These tests script the Anthropic SDK transport (messages.create), NOT the
 * LLM's semantics — control-flow testing of the inferencer's write loop and the
 * 0.7 confidence floor. Agent-behavior scoring is the cached-LLM eval
 * (run-memory-eval.mjs; hard rule #8 applies there, not here).
 */

const familyId = '11111111-1111-4111-8111-111111111111';
const INFER_TOOL = 'record_inference';

function inferenceMessage(input: unknown): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
    content: [
      { type: 'tool_use', id: 'tu_0', name: INFER_TOOL, input: input as Record<string, unknown> },
    ],
  };
}

function scriptedClient(input: unknown): MemoryInferencerClient {
  return {
    messages: { create: vi.fn(async () => inferenceMessage(input)) },
  } as unknown as MemoryInferencerClient;
}

function spies() {
  return {
    upsertFact: vi.fn<typeof upsertMemoryFact>(async () => ({ factId: 'f', superseded: false })),
    appendEpisode: vi.fn<typeof appendMemoryEpisode>(async () => ({ episodeId: 'e' })),
    retireFact: vi.fn<typeof retireMemoryFact>(async () => ({ retired: true })),
  };
}

const job = {
  familyId,
  windowDays: 7,
  recentEvents: [{ eventType: 'pediatric_appointment_request', payload: {} }],
  recentActions: [{ actionType: 'reply_to_email' }],
  currentMemorySnapshot: { facts: [], episodes: [] },
};

describe('runMemoryInferencer — write path + confidence floor', () => {
  it('writes facts at or above the 0.7 floor and drops those below', async () => {
    const dep = spies();
    const client = scriptedClient({
      fact_updates: [
        {
          fact_type: 'routine',
          fact_key: 'bedtime',
          fact_value: { time: '19:30' },
          confidence: 0.85,
          rationale: 'observed 5 times',
        },
        {
          fact_type: 'preference',
          fact_key: 'evening_appts',
          fact_value: { window: 'evening' },
          confidence: 0.7,
          rationale: 'observed 3 times',
        },
        {
          fact_type: 'preference',
          fact_key: 'speculative',
          fact_value: { guess: true },
          confidence: 0.5,
          rationale: 'weak signal',
        },
      ],
      episode_summaries: [],
      pattern_detections: [],
      retire_facts: [],
    });

    const result = await runMemoryInferencer(job, { client, ...dep });

    expect(result.factsWritten).toBe(2);
    expect(result.factsDropped).toBe(1);
    expect(dep.upsertFact).toHaveBeenCalledTimes(2);
    // The 0.5 fact was never written.
    const writtenKeys = dep.upsertFact.mock.calls.map((c) => c[0].factKey);
    expect(writtenKeys).toEqual(['bedtime', 'evening_appts']);
    // Each written fact carries inferredBy + the source family.
    expect(dep.upsertFact.mock.calls[0]?.[0].inferredBy).toBe('memory_inferencer');
    expect(dep.upsertFact.mock.calls[0]?.[0].familyId).toBe(familyId);
  });

  it('appends each episode and retires each fact_key seen in the snapshot', async () => {
    const dep = spies();
    const client = scriptedClient({
      fact_updates: [],
      episode_summaries: [
        {
          episode_type: 'appointment_confirmed',
          summary: 'Confirmed the 6-month visit.',
          occurred_at: '2026-06-10T12:00:00Z',
          sentiment_score: 0.4,
        },
      ],
      pattern_detections: [],
      retire_facts: ['stale_preference'],
    });

    // The retired key must have been currently-valid, so it appears in the
    // snapshot the model was shown — that is how its fact_type is resolved.
    const jobWithSnapshot = {
      ...job,
      currentMemorySnapshot: {
        facts: [{ factType: 'preference' as const, factKey: 'stale_preference' }],
        episodes: [],
      },
    };

    const result = await runMemoryInferencer(jobWithSnapshot, { client, ...dep });

    expect(result.episodesWritten).toBe(1);
    expect(result.factsRetired).toBe(1);
    expect(dep.appendEpisode).toHaveBeenCalledTimes(1);
    const ep = dep.appendEpisode.mock.calls[0]?.[0];
    expect(ep?.episodeType).toBe('appointment_confirmed');
    expect(ep?.occurredAt).toBeInstanceOf(Date);
    expect(dep.retireFact).toHaveBeenCalledTimes(1);
    // fact_type was resolved from the snapshot the model was shown.
    expect(dep.retireFact.mock.calls[0]?.[0]).toEqual({
      familyId,
      factType: 'preference',
      factKey: 'stale_preference',
    });
  });

  it('ignores a retire_facts key the model never saw in the snapshot', async () => {
    const dep = spies();
    const client = scriptedClient({
      fact_updates: [],
      episode_summaries: [],
      pattern_detections: [],
      retire_facts: ['never_seen'],
    });

    const result = await runMemoryInferencer(job, { client, ...dep });

    expect(result.factsRetired).toBe(0);
    expect(dep.retireFact).not.toHaveBeenCalled();
  });

  it('writes nothing and returns honest zero-counts when the model returns empty arrays', async () => {
    const dep = spies();
    const client = scriptedClient({
      fact_updates: [],
      episode_summaries: [],
      pattern_detections: [],
      retire_facts: [],
    });

    const result = await runMemoryInferencer(job, { client, ...dep });

    expect(result.factsWritten).toBe(0);
    expect(result.factsDropped).toBe(0);
    expect(result.episodesWritten).toBe(0);
    expect(result.factsRetired).toBe(0);
    expect(dep.upsertFact).not.toHaveBeenCalled();
    expect(dep.appendEpisode).not.toHaveBeenCalled();
    expect(dep.retireFact).not.toHaveBeenCalled();
  });

  it('returns run metrics summed from the model usage', async () => {
    const dep = spies();
    const client = scriptedClient({
      fact_updates: [],
      episode_summaries: [],
      pattern_detections: [],
      retire_facts: [],
    });

    const result = await runMemoryInferencer(job, { client, ...dep });

    expect(result.runMetrics.agentName).toBe('memory_inferencer');
    expect(result.runMetrics.promptTokens).toBe(100);
    expect(result.runMetrics.completionTokens).toBe(50);
  });
});
