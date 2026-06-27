import type { Database } from '@hale/db';
import { after } from 'next/server';
import { defaultDiscoverDeps, discoverForFamily } from '~/lib/village/discover';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

/**
 * Populates a just-onboarded family's village immediately, instead of leaving it
 * blank until the weekly discovery cron next runs. It reuses the EXISTING engine
 * (`discoverForFamily`) — the same one the cron and the on-demand "Find
 * activities" button call — so there is exactly one discovery path. The engine
 * reads the family's COARSE area only (rule #1: never the precise address; the
 * model payload is {area_coarse, stage, interests}) and writes the candidate rows
 * + its own audit row in one transaction (rule #6).
 *
 * It runs in the BACKGROUND (`after`): a full discovery is one Anthropic call plus
 * up to a handful of geocode lookups — too slow to block the "Finish" button. The
 * caller returns at once and routes the parent to /home, where the village page
 * streams the candidates as they land. A discovery failure must NEVER fail
 * onboarding, so it is caught + logged here (the family simply sees the existing
 * empty state until the next cron run) — this is the swallow-at-the-boundary case
 * (CLAUDE.md #8), identical to how the welcome email is fired.
 */
export type DiscoveryTrigger = (familyId: string, database: Database) => void;

export function defaultDiscoveryTrigger(): DiscoveryTrigger {
  return (familyId, database) => {
    after(async () => {
      try {
        await discoverForFamily(familyId, database, defaultDiscoverDeps());
      } catch (err) {
        console.error('first-village discovery failed (onboarding unaffected)', err);
      } finally {
        await flushTelemetry();
      }
    });
  };
}
