// A real runner process: live (capped) without HALE_SPEND_LEDGER exits non-zero before any
// call; with it set the run proceeds past the guard. Keys stay unset, so nothing is paid.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const script = `
  import { installSpendCap, readLedger } from ${JSON.stringify(join(here, '../../../web/lib/testing/spend-cap.mjs'))};
  const cap = installSpendCap(process.argv);
  globalThis.modelCalls = 0;
  // stands in for the runner's first model call
  globalThis.modelCalls += 1;
  console.log(JSON.stringify({ cap, spent: readLedger().spentUsd, calls: globalThis.modelCalls }));
`;

function run(env, args) {
  const clean = { ...process.env };
  for (const k of [
    'ANTHROPIC_API_KEY',
    'AI_GATEWAY_API_KEY',
    'HALE_SPEND_LEDGER',
    'HALE_MAX_USD',
    'HALE_ESTIMATE',
  ])
    delete clean[k];
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', ...args], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
}

describe('runner start', () => {
  it('a live run without HALE_SPEND_LEDGER exits non-zero before any call', () => {
    const r = run({}, ['--max-usd=0.5']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/HALE_SPEND_LEDGER is not set/);
    expect(r.stdout).toBe('');
  });

  it('with HALE_SPEND_LEDGER set the run proceeds', () => {
    const ledger = join(mkdtempSync(join(tmpdir(), 'ledger-guard-')), 'l.json');
    const r = run({ HALE_SPEND_LEDGER: ledger }, ['--max-usd=0.5']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ cap: 0.5, spent: 0, calls: 1 });
  });
});
