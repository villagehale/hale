import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./posthog-sourcemaps.mjs', import.meta.url));

describe('posthog-sourcemaps without a key', () => {
  it('exits 0, names the skip, and never reaches the CLI', () => {
    const env = { ...process.env, POSTHOG_PERSONAL_API_KEY: '', PATH: '' };
    // PATH is empty: if the script tried to spawn npx it could not, and would say so.
    const res = spawnSync(process.execPath, [SCRIPT, '.next', 'hale-web'], {
      env,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('POSTHOG_PERSONAL_API_KEY not set');
    expect(res.stdout).not.toContain('uploaded');
    expect(res.stdout).not.toContain('upload failed');
  });
});
