import { readFileSync, readdirSync, statSync } from 'node:fs';
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

/**
 * The replay tooling existed to re-enqueue jobs the ceiling had dropped. With no
 * ceiling there is nothing to replay, so the worker carries no script, source or test
 * for it. The aggregate spend alert (apps/web/lib/monitoring/spend.ts) is a different
 * thing and stays.
 */
function filesUnder(relative: string, out: string[] = []): string[] {
  for (const entry of readdirSync(`${ROOT}${relative}`)) {
    const path = `${relative}/${entry}`;
    if (statSync(`${ROOT}${path}`).isDirectory()) filesUnder(path, out);
    else out.push(path);
  }
  return out;
}

describe('the spend-ceiling replay tooling is deleted with the ceiling', () => {
  it('the worker has no script for it', () => {
    const scripts = Object.keys(
      (JSON.parse(readFileSync(`${ROOT}apps/worker/package.json`, 'utf8')) as {
        scripts: Record<string, string>;
      }).scripts,
    );
    expect(scripts).toContain('prompts:check');
    expect(scripts.filter((name) => name.includes('spend'))).toEqual([]);
  });

  it('no worker source, test or script names the ceiling', () => {
    const files = [...filesUnder('apps/worker/src'), ...filesUnder('apps/worker/scripts')];
    expect(files).toContain('apps/worker/scripts/sync-prompts.mjs');
    expect(files).toContain('apps/worker/src/orchestrator/index.ts');
    const naming = files.filter(
      (file) =>
        /spend[-_]ceiling/i.test(file) ||
        /spend_ceiling|spend-ceiling|spendCeiling/i.test(readFileSync(`${ROOT}${file}`, 'utf8')),
    );
    expect(naming).toEqual([]);
  });

  it('positive control: the aggregate spend alert is still there', () => {
    const alert = readFileSync(`${ROOT}apps/web/lib/monitoring/spend.ts`, 'utf8');
    expect(alert).toContain('ANTHROPIC_SPEND_ALERT_USD');
  });
});
