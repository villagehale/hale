import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The modes that cost nothing run on every test pass, with no key in the environment:
// --dry grades the planner and prices one recording, --broken must fail every fixture.

const RUNNER = fileURLToPath(new URL('./run-group-conflict-alert-eval.mjs', import.meta.url));
const KEYLESS = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/ANTHROPIC|AI_GATEWAY|LINQ|DATABASE|BROWSER_USE|HALE_SPEND|HALE_MAX/.test(key),
  ),
);
const run = (args) =>
  spawnSync(process.execPath, [RUNNER, ...args], { env: KEYLESS, encoding: 'utf8' });

describe('run-group-conflict-alert-eval.mjs', () => {
  it.each([[[]], [['--dyr']], [['--dry', '--cached-only']], [['--max-usd', '0.2']]])(
    'exits 2 on %j before anything runs',
    (args) => {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
    },
  );

  it('refuses --live without a spend cap and a ledger', () => {
    const result = run(['--live']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/spend cap/);
  });

  it('--dry passes the planner, makes no calls, and prints the worst case', () => {
    const result = run(['--dry']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/planner FAIL/);
    expect(result.stdout).toMatch(/DRY summary .* worst \$\d+\.\d{5}/);
    expect(result.stdout).toMatch(/live calls: 0/);
  }, 60_000);

  it('--broken fails every fixture without a model', () => {
    const result = run(['--broken']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/live API calls this run: 0/);
    expect(result.stdout).toMatch(/broken-mode calibration \(must fail\): PASS/);
    expect(result.stdout).not.toMatch(/^PASS /m);
  }, 60_000);
});
