import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVAL_MODES, noClient, parseEvalFlags, worstCaseUsd } from './lib/eval-flags.mjs';

const RUNNER = fileURLToPath(new URL('./run-group-turn-read-eval.mjs', import.meta.url));
const KEYLESS = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/ANTHROPIC|AI_GATEWAY|LINQ|DATABASE|BROWSER_USE|HALE_SPEND/.test(k),
  ),
);
const run = (args) =>
  spawnSync(process.execPath, [RUNNER, ...args], { env: KEYLESS, encoding: 'utf8' });

describe('parseEvalFlags', () => {
  it.each(EVAL_MODES)('accepts %s alone', (flag) => {
    expect(parseEvalFlags([flag])).toBe(flag.slice(2));
  });
  it.each([
    [[]],
    [['--dyr']],
    [['--dry', '--live']],
    [['--dry', '--dry']],
    [['--live', '--max-usd', '1']],
  ])('rejects %j', (args) => {
    expect(() => parseEvalFlags(args)).toThrow();
  });
  it('noClient throws on use', () => {
    expect(() => noClient('t')()).toThrow(/outside --live/);
  });
  it('worstCaseUsd refuses an unpriced model', () => {
    expect(() => worstCaseUsd('nope', 1, 1)).toThrow();
  });
});

describe('run-group-turn-read-eval.mjs flags', () => {
  it.each([[[]], [['--dyr']], [['--dry', '--cached-only']], [['--max-usd', '0.2']]])(
    'exits 2 on %j before anything runs',
    (args) => {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
    },
  );
  it('--dry makes no calls and prints a worst case', () => {
    const r = run(['--dry']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY summary .* worst \$\d+\.\d{5}/);
    expect(r.stdout).toMatch(/live calls: 0/);
  }, 60_000);
  it('--cached-only (the CI flag) still replays green', () => {
    const r = run(['--cached-only']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/live API calls this run: 0/);
  }, 60_000);
});
