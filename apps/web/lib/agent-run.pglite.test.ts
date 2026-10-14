import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAgentRun } from '~/lib/agent-run';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

async function readCacheColumns(id: string) {
  const [row] = await db.database
    .select({
      cacheReadTokens: schema.agentRuns.cacheReadTokens,
      cacheWriteTokens: schema.agentRuns.cacheWriteTokens,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, id));
  if (!row) throw new Error('agent_runs row not found');
  return row;
}

const BASE = {
  agentName: 'coach-channel-sms' as const,
  modelUsed: 'test-model',
  promptTokens: 150,
  completionTokens: 20,
  costUsd: 0.001,
  status: 'completed' as const,
};

describe('recordAgentRun — prompt-cache tokens', () => {
  it('persists the cache read and write counts it is given', async () => {
    const family = await seedFamily(db.database, 'Cache Family');
    const id = await recordAgentRun(db.database, {
      ...BASE,
      familyId: family.familyId,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
    });
    const row = await readCacheColumns(id);
    expect(row.cacheReadTokens).toBe(400);
    expect(row.cacheWriteTokens).toBe(50);
  });

  it('stores NULL in both columns when the writer does not measure the cache', async () => {
    const family = await seedFamily(db.database, 'Unmeasured Family');
    const id = await recordAgentRun(db.database, { ...BASE, familyId: family.familyId });
    const row = await readCacheColumns(id);
    expect(row.cacheReadTokens).toBeNull();
    expect(row.cacheWriteTokens).toBeNull();
  });
});
