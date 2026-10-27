import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WEEKDAY_CARE_REPLY_BROKEN,
  WEEKDAY_CARE_REPLY_FIXTURES,
} from './weekday-care-reply-fixtures.mjs';

const RUNNER = fileURLToPath(new URL('./weekday-care-reply-eval.mjs', import.meta.url));

describe('weekday-care-reply eval', () => {
  it('has exactly one broken reading per fixture, each a valid tool shape', () => {
    const ids = WEEKDAY_CARE_REPLY_FIXTURES.map((f) => f.id).sort();
    expect(Object.keys(WEEKDAY_CARE_REPLY_BROKEN).sort()).toEqual(ids);
    for (const reading of Object.values(WEEKDAY_CARE_REPLY_BROKEN)) {
      expect(['home', 'daycare', 'starting_soon', 'nothing']).toContain(reading.care);
      expect(['high', 'medium', 'low']).toContain(reading.confidence);
    }
  });

  it('--estimate prices the suite with no API key and no live call', () => {
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const run = spawnSync(process.execPath, [RUNNER, '--estimate'], { env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/live API calls: 0\. nothing written\./);
  }, 60_000);

  it('--estimate refuses to run with another mode', () => {
    const run = spawnSync(process.execPath, [RUNNER, '--estimate', '--broken'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(2);
  }, 60_000);
});
