import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Everyone gets everything free (VIL-131), so no signed-in parent can reach a Stripe
 * checkout: the route is deleted, and with no route module Next answers 404. The smoke
 * walk (e2e/smoke/authed-flag-on.spec.ts) asks the running app for that 404 as a
 * signed-in parent; this keeps the route from coming back between smoke runs.
 */

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const ROUTE_PATH = 'billing/checkout';

function filesUnder(relative: string, out: string[] = []): string[] {
  for (const entry of readdirSync(`${WEB}${relative}`)) {
    const path = `${relative}/${entry}`;
    if (statSync(`${WEB}${path}`).isDirectory()) filesUnder(path, out);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

describe('/api/billing/checkout is deleted', () => {
  it('has no route module', () => {
    expect(existsSync(`${WEB}app/api/health/route.ts`)).toBe(true);
    expect(existsSync(`${WEB}app/api/${ROUTE_PATH}/route.ts`)).toBe(false);
    expect(existsSync(`${WEB}app/api/billing`)).toBe(false);
  });

  it('nothing in the app, its components or its lib still points at it', () => {
    const files = [...filesUnder('app'), ...filesUnder('components'), ...filesUnder('lib')];
    expect(files).toContain('app/api/health/route.ts');
    const callers = files.filter((file) => readFileSync(`${WEB}${file}`, 'utf8').includes(ROUTE_PATH));
    expect(callers).toEqual([]);
  });
});
