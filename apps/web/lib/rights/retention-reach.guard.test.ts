import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the two record-retention clocks (record-retention.ts) cannot reach by themselves,
 * held as two lists a new module has to join on purpose.
 *
 * A removed episode keeps its words for thirty days, then is blanked. Until then the row
 * is still there, so every module that reads `family_memory_episodes` must either skip a
 * removed one (`deleted_at is null`) or show none of its words. Each entry says which.
 *
 * A proactive candidate is deleted after a year, which frees its (family_id, dedupe_key)
 * slot. That is safe only while no module that queues candidates would write the same key
 * again to send the same text twice. Each entry says why it will not.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

const EPISODE_READ =
  /\.from\(\s*(?:schema\.)?familyMemoryEpisodes\s*\)|\$\{schema\.familyMemoryEpisodes\}|=\s*schema\.familyMemoryEpisodes\s*;/;

const EPISODE_READERS: Record<string, string> = {
  'apps/worker/src/services/memory-context.ts':
    'episodesForContext, the one prompt reader (coach, inferencer, drafter): deleted_at is null',
  'apps/web/lib/companion/recent-logs.ts': 'deleted_at is null',
  'apps/web/lib/companion/queries.ts': 'deleted_at is null',
  'apps/web/lib/companion/log-write.ts': 'edits only a live row: deleted_at is null',
  'apps/web/lib/home/aggregates.ts': 'deleted_at is null',
  'apps/web/lib/rights/export-memory.ts':
    'the access export: a removed episode leaves with its time, type and removal date, never its summary; payload is never exported',
  'apps/web/lib/rights/record-retention.ts': 'the thirty-day blank itself',
  'apps/web/lib/memory/timeline/replay.ts':
    'the timeline eval harness: it reads the pglite database it seeded, never production',
};

const CANDIDATE_WRITE =
  /handOffProactive\(|queueCheckInForDecider\b|insert\(\s*(?:schema\.)?proactiveCandidates\s*\)/;

const CANDIDATE_PRODUCERS: Record<string, string> = {
  'apps/web/lib/channel/proactive/queue.ts': 'the two inserts every producer below goes through',
  'apps/web/lib/channel/checkin/sweep.ts': 'the key names the local day',
  'apps/web/lib/channel/mid-activity/sweep.ts':
    'the key names the session day, and the ask is queued only inside its window that evening',
  'apps/web/lib/channel/nudge/run.ts':
    'keys name a week, a Saturday or a registration window. The weekday-care asks are keyed per prompt with no date: a year after a dropped ask, Hale may weigh it once more, and a sent one stays claimed in channel_messages (never deleted), which the decider reads before any send (review.ts dropAlreadySent)',
  'apps/web/lib/channel/coparent/departure-notice.ts':
    'the key names one departure, queued only at the departure or by its redrive inside the staleness bound',
};

const SCAN_ROOTS = ['apps/web/app', 'apps/web/lib', 'apps/worker/src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function matching(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      if (pattern.test(readFileSync(file, 'utf8'))) found.push(file.slice(REPO_ROOT.length + 1));
    }
  }
  return found.sort();
}

describe('the detectors', () => {
  it('see a read and a queueing, and not a write or a lookup', () => {
    expect(EPISODE_READ.test('db.select().from(schema.familyMemoryEpisodes)')).toBe(true);
    expect(EPISODE_READ.test('const episodes = schema.familyMemoryEpisodes;')).toBe(true);
    expect(EPISODE_READ.test('tx.insert(schema.familyMemoryEpisodes).values({})')).toBe(false);
    expect(CANDIDATE_WRITE.test('await handOffProactive(database, drafts, lane)')).toBe(true);
    expect(CANDIDATE_WRITE.test('.insert(schema.proactiveCandidates)')).toBe(true);
    expect(CANDIDATE_WRITE.test('.from(schema.proactiveCandidates)')).toBe(false);
  });
});

describe('a removed episode’s words reach no reader before the blank', () => {
  it('every module that reads the table is listed with how it skips a removed one', () => {
    const readers = matching(EPISODE_READ);
    // Positive control: the scan reaches the prompt reader, so an empty result is not blind.
    expect(readers).toContain('apps/worker/src/services/memory-context.ts');
    expect(readers).toEqual(Object.keys(EPISODE_READERS).sort());
  });
});

describe('no proactive candidate key outlives the year-old delete', () => {
  it('every module that queues a candidate is listed with why its key is not re-sent', () => {
    const producers = matching(CANDIDATE_WRITE);
    expect(producers).toContain('apps/web/lib/channel/proactive/queue.ts');
    expect(producers).toEqual(Object.keys(CANDIDATE_PRODUCERS).sort());
  });
});
