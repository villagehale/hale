import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POSTHOG_CLI } from './posthog-sourcemaps.mjs';

const SCRIPT = fileURLToPath(new URL('./posthog-sourcemaps.mjs', import.meta.url));

/** A fake .next with maps nested at two depths, plus a JS file that must survive. */
function fakeBuild() {
  const dir = mkdtempSync(join(tmpdir(), 'ph-maps-'));
  mkdirSync(join(dir, 'static', 'chunks'), { recursive: true });
  writeFileSync(join(dir, 'static', 'chunks', 'app.js'), '//');
  writeFileSync(join(dir, 'static', 'chunks', 'app.js.map'), '{}');
  writeFileSync(join(dir, 'server.js.map'), '{}');
  return dir;
}

function run(dir, env) {
  return spawnSync(process.execPath, [SCRIPT, dir, 'hale-web'], {
    // PATH empty: if the script spawns npx it cannot succeed — the failure path.
    env: { ...process.env, PATH: '', ...env },
    encoding: 'utf8',
  });
}

function mapsLeft(dir) {
  return [join(dir, 'static', 'chunks', 'app.js.map'), join(dir, 'server.js.map')].filter((p) =>
    existsSync(p),
  );
}

describe('posthog-sourcemaps always deletes maps', () => {
  it('skip (no key): exits 0, names the skip, never reaches the CLI, deletes maps', () => {
    const dir = fakeBuild();
    const res = run(dir, { POSTHOG_PERSONAL_API_KEY: '' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('skipped: POSTHOG_PERSONAL_API_KEY not set');
    expect(res.stdout).toContain('deleted 2 .map file(s)');
    expect(mapsLeft(dir)).toEqual([]);
    expect(existsSync(join(dir, 'static', 'chunks', 'app.js'))).toBe(true);
  });

  it('failed upload (CLI cannot run): exits 0 and still deletes maps', () => {
    const dir = fakeBuild();
    const res = run(dir, { POSTHOG_PERSONAL_API_KEY: 'phx_test_not_real' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/upload (failed|threw)/);
    expect(res.stdout).toContain('deleted 2 .map file(s)');
    expect(mapsLeft(dir)).toEqual([]);
    // The key never appears in output.
    expect(res.stdout + res.stderr).not.toContain('phx_test_not_real');
  });

  it('missing build dir: exits 0, nothing to delete', () => {
    const res = run(join(tmpdir(), 'ph-maps-does-not-exist'), { POSTHOG_PERSONAL_API_KEY: '' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('deleted 0 .map file(s)');
  });

  it('pins the CLI to an exact version', () => {
    expect(POSTHOG_CLI).toMatch(/^@posthog\/cli@\d+\.\d+\.\d+$/);
  });
});

describe('next.config only emits browser maps when the key is set', () => {
  for (const app of ['web', 'site']) {
    it(`apps/${app}/next.config.ts`, async () => {
      const src = (await import('node:fs')).readFileSync(
        fileURLToPath(new URL(`../apps/${app}/next.config.ts`, import.meta.url)),
        'utf8',
      );
      expect(src).toContain(
        'productionBrowserSourceMaps: Boolean(process.env.POSTHOG_PERSONAL_API_KEY)',
      );
    });
  }
});
