import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Chat turns do not pass through the hard LLM-cost ceiling. The silent drops
 * were events.ingested and the web ingest door, both before classify. A future
 * check inside the router or the coach would block a free account again.
 */

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const SURFACES = ['apps/web/lib/channel/router/route.ts', 'apps/web/lib/channel/coach/runtime.ts'];

const FORBIDDEN = [
  'isOverHardCeiling',
  'hardCeilingUsd',
  'spend_ceiling',
  'SPEND_CEILING_ENFORCED',
  'monthlyAllowanceUsd',
];

describe('chat surfaces do not consult the monthly LLM-cost ceiling', () => {
  it.each(SURFACES)('%s has no ceiling gate', (relative) => {
    const source = readFileSync(`${ROOT}${relative}`, 'utf8');
    for (const needle of FORBIDDEN) {
      expect(source, needle).not.toContain(needle);
    }
  });
});
