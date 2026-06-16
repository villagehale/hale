import type { DiscoveryQuery, FamilyStage } from '@hale/types';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { FakeDiscoveryProvider } from './discovery-providers/fake.js';
import type { DiscoveredCandidate, DiscoveryProvider } from './discovery-providers/types.js';
import { WebGroundedDiscoveryProvider } from './discovery-providers/web-grounded.js';

/**
 * Discovery agent — finds local, stage-appropriate enrichment activities for a
 * family. The activity SOURCE is injected (mirrors the executor's deps):
 *   - default off → the Fake curated floor (always available, no network).
 *   - VILLAGE_WEB_GROUNDING=true → the live web-grounded provider.
 * Tests pass a Fake (or any stub) so discovery is exercised without a live call.
 *
 * Privacy (rule #1): the query carries a COARSE area + stage + interests only —
 * never a precise child location, name, or DOB. We log the coarse area only.
 */

const DEFAULT_LIMIT = 8;

export interface DiscoveryRunInput {
  familyId: string;
  areaCoarse: string;
  stage: FamilyStage;
  interests: string[];
  limit?: number;
}

export interface DiscoveryRunOutput {
  provider: string;
  candidates: DiscoveredCandidate[];
}

export interface DiscoveryDeps {
  provider: DiscoveryProvider;
}

function defaultDeps(): DiscoveryDeps {
  return {
    provider: config.VILLAGE_WEB_GROUNDING
      ? new WebGroundedDiscoveryProvider()
      : new FakeDiscoveryProvider(),
  };
}

export async function runDiscovery(
  input: DiscoveryRunInput,
  deps: DiscoveryDeps = defaultDeps(),
): Promise<DiscoveryRunOutput> {
  const query: DiscoveryQuery = {
    areaCoarse: input.areaCoarse,
    stage: input.stage,
    interests: input.interests,
    limit: input.limit ?? DEFAULT_LIMIT,
  };

  logger.info(
    {
      familyId: input.familyId,
      areaCoarse: input.areaCoarse,
      stage: input.stage,
      provider: deps.provider.name,
    },
    'discovery: running',
  );

  const candidates = await deps.provider.discover(query);

  return { provider: deps.provider.name, candidates };
}
