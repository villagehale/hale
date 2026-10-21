import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('weekly civic catalog retirement', () => {
  it('has no schedule or callable route that can repopulate the weekly catalog', () => {
    const { crons } = JSON.parse(readFileSync(`${WEB_ROOT}vercel.json`, 'utf8')) as {
      crons: { path: string }[];
    };
    expect(crons.some(({ path }) => path === '/api/cron/civic-sweep')).toBe(false);
    expect(existsSync(`${WEB_ROOT}app/api/cron/civic-sweep/route.ts`)).toBe(false);
    expect(existsSync(`${WEB_ROOT}lib/cron/civic-sweep.ts`)).toBe(false);
  });
});
