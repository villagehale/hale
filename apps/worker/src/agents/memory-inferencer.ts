interface InferencerJob {
  familyId: string;
  windowDays: number;
  recentEvents?: unknown[];
  recentActions?: unknown[];
  currentMemorySnapshot?: unknown;
}

/**
 * Memory Inferencer — Sonnet 4.6, batched.
 *
 * Disabled until the write path lands. Until then we throw
 * MIRA_NOT_CONFIGURED rather than silently parse output and drop it —
 * a "succeeded" run with no DB writes is the dishonest stub pattern.
 *
 * To enable: implement upsert helpers in @mira/db for
 * family_memory_facts (with valid_until supersedence) and
 * family_memory_episodes; then restore the agent body.
 */
export async function runMemoryInferencer(job: InferencerJob): Promise<void> {
  const err = new Error(
    `MIRA_NOT_CONFIGURED: Memory Inferencer is disabled until @mira/db exposes family_memory_facts upsert + family_memory_episodes append (familyId=${job.familyId}, windowDays=${job.windowDays})`,
  );
  err.name = 'MiraNotConfiguredError';
  throw err;
}
