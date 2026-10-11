import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No family is held, throttled or dropped because of its plan or its spend
 * (VIL-131). The chat turns, the events.ingested orchestrator, the web ingest door
 * and the approvals page carry no ceiling, allowance or plan gate, and no upgrade
 * surface. `planTier` itself is not forbidden: the coach runtime uses it as a
 * trace tag. Each file's sentinel is the positive control that the scan read the
 * real surface rather than an empty or moved file.
 */

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const SURFACES: Record<string, string> = {
  'apps/web/lib/channel/router/route.ts': 'routeChannelMessage(',
  'apps/web/lib/channel/coach/runtime.ts': 'channelCoachRuntime(',
  'apps/worker/src/orchestrator/index.ts': 'runOrchestrator(',
  'apps/web/lib/pipeline/ingest.ts': 'ingestEvent(',
  'apps/web/app/(authed)/approvals/page.tsx': 'ApprovalCard',
};

const FORBIDDEN = [
  'isOverHardCeiling',
  'hardCeilingUsd',
  'spend_ceiling',
  'SPEND_CEILING_ENFORCED',
  'monthlyAllowanceUsd',
  'hasEntitlement',
  'entitlementRequiredFor',
  'isOverAllowance',
  'loadFamilyPlanTier',
  'MonthToDateCost',
  'over_allowance',
  'UpgradePrompt',
];

describe('no surface consults a plan gate, an allowance or the LLM-cost ceiling', () => {
  it.each(Object.entries(SURFACES))('%s has no ceiling or plan gate', (relative, sentinel) => {
    const source = readFileSync(`${ROOT}${relative}`, 'utf8');
    expect(source, `sentinel ${sentinel}`).toContain(sentinel);
    for (const needle of FORBIDDEN) {
      expect(source, needle).not.toContain(needle);
    }
  });
});
