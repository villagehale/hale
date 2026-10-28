import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { schema } from '@hale/db';
import { expect, it } from 'vitest';

it('retires civic producers and catalog bindings without removing registration storage', () => {
  for (const path of [
    '../civic/sweep.ts',
    '../civic/project.ts',
    '../civic/bibliocommons.ts',
    '../civic/earlyon-toronto.ts',
    '../civic/library-systems.ts',
    '../civic/parse-hours.ts',
    '../onboarding/trigger-discovery.ts',
    './rank/upsert.ts',
  ]) {
    expect(existsSync(new URL(path, import.meta.url)), path).toBe(false);
  }
  expect('villageCandidates' in schema).toBe(false);
  expect('villageFeedRank' in schema).toBe(false);
  expect(schema.familyActivityHistory).toBeDefined();
  expect(schema.registrationWindows).toBeDefined();
});

it('allows only the four approved historical catalog references outside migrations and tests', () => {
  const allowed = new Set([
    'apps/web/lib/reviews/subject.ts',
    'apps/web/lib/trail/verbs.ts',
    'apps/worker/evals/cache/3e39921a83d84a08e5a4449064cc6c4c37c8c2c8461cde483263619b57a35407.json',
    'apps/worker/evals/cache/187cb87f4f839e05120c88861ba3dc5e9fe83adc39f66e43a5eecc8235e4fcde.json',
  ]);
  const scan = spawnSync(
    'git',
    ['grep', '-l', '-z', '-F', 'village_candidates', '--', 'apps', 'packages', 'scripts'],
    {
      cwd: new URL('../../../../', import.meta.url),
      encoding: 'utf8',
    },
  );
  expect(scan.error).toBeUndefined();
  expect([0, 1]).toContain(scan.status);
  const unexpected = scan.stdout
    .split('\0')
    .filter(
      (path) =>
        path &&
        !allowed.has(path) &&
        !path.startsWith('packages/db/drizzle/') &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
    );
  expect(unexpected).toEqual([]);
});
