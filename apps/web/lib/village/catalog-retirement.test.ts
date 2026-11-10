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
