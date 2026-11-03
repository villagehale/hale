import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, DEEPSEEK_MODEL, SONNET_MODEL } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type NonGoogleClearance,
  assertClearance,
  clearForNonAnthropic,
} from '~/lib/pipeline/provider-clearance';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { defaultInferenceDeps, runInferenceForFamily } from './inference';

/**
 * VIL-556: memory inference reads family-wide state (events, episodes, facts,
 * conversations, bookings, family events), and for a family that connected Gmail or
 * Calendar that state carries Google-derived content with no per-row origin to filter
 * on. So the DeepSeek candidate runs only for a family that has never had a Google
 * integrations row, in any status. Everything else stays on Anthropic, whatever
 * HALE_MEMORY_INFER_MODEL_MODE says.
 *
 * ROUTING only: which client is called and which model is recorded. The fake clients
 * answer one plain turn; inference quality is the memory-writeback eval (rule #8).
 */

const NOW = new Date('2026-06-17T06:00:00Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function plainTurnClient(): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: 'Nothing new to save.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 6, output_tokens: 4 },
      })),
    },
  } as unknown as AgentClient;
}

async function addIntegration(
  familyId: string,
  provider: 'gmail' | 'gcal',
  status: 'active' | 'revoked',
): Promise<void> {
  await db.database
    .insert(schema.integrations)
    .values({ familyId, userId: null, provider, status, oauthTokensEncrypted: null });
}

async function modelsRecorded(familyId: string): Promise<string[]> {
  const rows = await db.database
    .select({ modelUsed: schema.agentRuns.modelUsed })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.familyId, familyId));
  return rows.map((row) => row.modelUsed);
}

describe('runInferenceForFamily · candidate mode keeps Google families on Anthropic', () => {
  it.each([
    ['a revoked Gmail connection', 'gmail', 'revoked'],
    ['an active Calendar connection', 'gcal', 'active'],
  ] as const)(
    'a family with %s runs Sonnet and names the refusal',
    async (_label, provider, status) => {
      const { familyId } = await seedFamily(db.database, 'Guard Google');
      await addIntegration(familyId, provider, status);
      const anthropic = plainTurnClient();
      const candidateClient = vi.fn((_clearance: NonGoogleClearance) => plainTurnClient());

      const result = await runInferenceForFamily(
        familyId,
        db.database,
        { client: anthropic, modelMode: 'candidate', candidateClient },
        NOW,
      );

      expect(candidateClient).not.toHaveBeenCalled();
      expect(anthropic.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: SONNET_MODEL }),
      );
      expect(await modelsRecorded(familyId)).toEqual([SONNET_MODEL]);
      expect(result.candidateRefusal).toBe('family_has_google_connection');
    },
  );

  it('positive control: a family with no Google row reaches the candidate', async () => {
    const { familyId } = await seedFamily(db.database, 'Guard None');
    const anthropic = plainTurnClient();
    const gateway = plainTurnClient();
    const candidateClient = vi.fn((_clearance: NonGoogleClearance) => gateway);

    const result = await runInferenceForFamily(
      familyId,
      db.database,
      { client: anthropic, modelMode: 'candidate', candidateClient },
      NOW,
    );

    expect(candidateClient).toHaveBeenCalledTimes(1);
    const clearance = candidateClient.mock.calls[0]?.[0];
    if (!clearance) throw new Error('candidateClient was called without a clearance');
    expect(clearance.basis).toBe('family_without_google');
    expect(() => assertClearance(clearance)).not.toThrow();
    expect(gateway.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEEPSEEK_MODEL, thinking: { type: 'disabled' } }),
    );
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(await modelsRecorded(familyId)).toEqual([DEEPSEEK_MODEL]);
    expect(result.candidateRefusal).toBeNull();
  });
});

describe('defaultInferenceDeps · candidate mode', () => {
  it('keeps the Anthropic client as the default and builds the gateway only per clearance', async () => {
    vi.stubEnv('HALE_MEMORY_INFER_MODEL_MODE', 'candidate');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-no-network');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key-no-network');

    const deps = defaultInferenceDeps();
    if (deps.modelMode !== 'candidate')
      throw new Error(`expected candidate, got ${deps.modelMode}`);
    expect((deps.client as Anthropic).baseURL).not.toBe('https://ai-gateway.vercel.sh');
    expect(typeof deps.candidateClient).toBe('function');

    // Positive control for the baseURL check: the cleared factory IS the gateway.
    const { familyId } = await seedFamily(db.database, 'Guard Factory');
    const decision = await clearForNonAnthropic(
      { kind: 'family_state', database: db.database, familyId },
      'factory test',
    );
    if (!('cleared' in decision))
      throw new Error('expected a clearance for a family without Google');
    expect((deps.candidateClient(decision.cleared) as Anthropic).baseURL).toBe(
      'https://ai-gateway.vercel.sh',
    );
  });
});
