import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CARPOOL_JUDGE_CASES, gradeCarpool } from './carpool-judge-fixtures.mjs';

describe('VIL-445 carpool judge cases', () => {
  it('covers the four ticket cases and does not match words', () => {
    expect(CARPOOL_JUDGE_CASES.map((item) => item.id)).toEqual([
      'driver-swap',
      'no-driver-ask-once',
      'quiet-hours',
      'cancelled',
    ]);
    const source = readFileSync(new URL('./carpool-judge-fixtures.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/meaning, 1 to 5/);
    expect(source).not.toMatch(/toLowerCase|includes\(|match\(/);
  });

  it('holds when the judge does not return a score', async () => {
    const item = CARPOOL_JUDGE_CASES[0];
    const missing = await gradeCarpool(item, 'Priya is driving', async () => null);
    const thrown = await gradeCarpool(item, 'Priya is driving', async () => {
      throw new Error('no');
    });
    expect(missing).toEqual({ id: 'driver-swap', pass: false, reason: 'judge_unsent' });
    expect(thrown).toEqual({ id: 'driver-swap', pass: false, reason: 'judge_unsent' });
  });

  it('passes a 5 and fails a 2', async () => {
    const item = CARPOOL_JUDGE_CASES[0];
    const pass = await gradeCarpool(item, 'reminder follows Priya', async () => ({
      score: 5,
      reason: 'swap landed',
    }));
    const fail = await gradeCarpool(item, 'reminder follows Maya', async () => ({
      score: 2,
      reason: 'stale driver',
    }));
    expect(pass.pass).toBe(true);
    expect(fail.pass).toBe(false);
  });
});
