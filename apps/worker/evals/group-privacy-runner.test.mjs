import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('rejects an unmatched per-case selection before constructing any model request', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./run-group-privacy-eval.mjs', import.meta.url)),
      '--cached-only',
      '--only=not-a-fixture',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('No group privacy fixtures matched --only');
});
