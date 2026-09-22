import { type Database, schema } from '@hale/db';
import { count } from 'drizzle-orm';
import {
  type FamilyDigestResult,
  resolveDigestMode,
  runFamilyMemoryDigest,
} from '~/lib/memory/digest';
import { MAX_FAMILIES_PER_RUN, selectFamiliesForRun } from './families';

/**
 * The memory-digest window. Observe-only unless MEMORY_DIGEST_APPLY is exactly
 * `true` and MEMORY_DIGEST_FAMILY_ALLOWLIST names the family. No model call,
 * no send.
 */

export interface DigestCronResult {
  apply: boolean;
  allowlistSize: number;
  families: number;
  deferredFamilies: number;
  candidates: number;
  added: number;
  updated: number;
  unchanged: number;
  superseded: number;
  forgotten: number;
  deferred: number;
  failures: number;
  aliasCandidates: number;
  aliasesWritten: number;
  contradictionCandidates: number;
  results: Array<
    { familyId: string; result: FamilyDigestResult } | { familyId: string; error: 'digest_failed' }
  >;
}

function add(total: DigestCronResult, result: FamilyDigestResult): void {
  total.candidates += result.candidates;
  total.added += result.added;
  total.updated += result.updated;
  total.unchanged += result.unchanged;
  total.superseded += result.superseded;
  total.forgotten += result.forgotten;
  total.deferred += result.deferred;
  total.aliasCandidates += result.aliasCandidates;
  total.aliasesWritten += result.aliasesWritten;
  total.contradictionCandidates += result.contradictionCandidates;
}

export async function runMemoryDigestCron(
  database: Database,
  now: Date = new Date(),
): Promise<DigestCronResult> {
  const mode = resolveDigestMode(process.env);
  const [familyIds, counted] = await Promise.all([
    selectFamiliesForRun(database, MAX_FAMILIES_PER_RUN.memoryDigest),
    database.select({ n: count() }).from(schema.families),
  ]);
  const totalFamilies = Number(counted[0]?.n ?? 0);
  const summary: DigestCronResult = {
    apply: mode.apply,
    allowlistSize: mode.allowlist.size,
    families: familyIds.length,
    deferredFamilies: Math.max(0, totalFamilies - familyIds.length),
    candidates: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    superseded: 0,
    forgotten: 0,
    deferred: 0,
    failures: 0,
    aliasCandidates: 0,
    aliasesWritten: 0,
    contradictionCandidates: 0,
    results: [],
  };

  for (const familyId of familyIds) {
    const applied = mode.apply && mode.allowlist.has(familyId);
    try {
      const result = await runFamilyMemoryDigest(database, familyId, now, applied);
      summary.results.push({ familyId, result });
      add(summary, result);
    } catch {
      summary.failures += 1;
      summary.results.push({ familyId, error: 'digest_failed' });
    }
  }
  return summary;
}
