import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coachHelpLines } from './coach-help-lines.mjs';

describe('coachHelpLines: a fixture row gets the lines production would hand it (VIL-589)', () => {
  it('an Ontario fixture carries 811 and 911; a US fixture and any group turn carry no 811', async () => {
    const said = async (location, audience) =>
      JSON.stringify(await coachHelpLines(location, audience));

    const ontario = await said({ province: 'ON', country: 'CA' });
    expect(ontario).toMatch(/\b811\b/);
    expect(ontario).toMatch(/\b911\b/);
    for (const elsewhere of [
      await said({ province: 'OH', country: 'US' }),
      await said({ province: 'ON', country: 'CA' }, 'group'),
    ]) {
      expect(elsewhere).not.toMatch(/811/);
      expect(elsewhere).toMatch(/\b911\b/);
    }
  });
});

describe('every runner that loads the coach skill hands it the helpLines production sends', () => {
  it('a run-*.mjs loading coach-channel-sms either builds helpLines or drives the runtime port', () => {
    const evals = join(dirname(fileURLToPath(import.meta.url)), '..');
    const runners = readdirSync(evals).filter(
      (name) =>
        /^run-.*\.mjs$/.test(name) &&
        readFileSync(join(evals, name), 'utf8').includes('coach-channel-sms'),
    );
    expect(runners).toContain('run-coach-channel-eval.mjs');
    const missing = runners.filter((name) => {
      const source = readFileSync(join(evals, name), 'utf8');
      return !source.includes('coachHelpLines(') && !source.includes('fixtureHealthPlace(');
    });
    expect(missing).toEqual([]);
  });
});
