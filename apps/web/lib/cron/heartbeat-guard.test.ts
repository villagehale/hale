import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of the dead-man switch (audit P1-8): a cron that never
 * stamps cron_heartbeats reads permanently stale and pages the founder for no
 * reason — or worse, teaches everyone to ignore the page. So stamping is not a
 * convention, it is the only door: every scheduled cron's route must be built
 * with `cronRoute('<its own slug>', …)`, which authenticates AND stamps, and
 * no route may reach for `requireCronSecret` directly. Checked against the
 * real vercel.json and the real route sources — a constant list would drift.
 */

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface CronEntry {
  path: string;
  schedule: string;
}

function crons(): CronEntry[] {
  return (JSON.parse(readFileSync(`${WEB_ROOT}vercel.json`, 'utf8')) as { crons: CronEntry[] })
    .crons;
}

describe('cron heartbeat guard', () => {
  it('every scheduled cron routes through cronRoute with its own slug', () => {
    for (const { path } of crons()) {
      const slug = path.split('/').at(-1);
      const source = readFileSync(`${WEB_ROOT}app/api/cron/${slug}/route.ts`, 'utf8');
      expect(source, `${path} must stamp the dead-man ledger via cronRoute('${slug}', …)`).toContain(
        `cronRoute('${slug}'`,
      );
    }
  });

  it('no cron route bypasses the wrapper by calling requireCronSecret itself', () => {
    for (const dir of readdirSync(`${WEB_ROOT}app/api/cron`)) {
      const source = readFileSync(`${WEB_ROOT}app/api/cron/${dir}/route.ts`, 'utf8');
      expect(
        source.includes('requireCronSecret'),
        `${dir}/route.ts must use cronRoute — requireCronSecret alone authenticates without stamping the dead-man ledger`,
      ).toBe(false);
    }
  });
});
