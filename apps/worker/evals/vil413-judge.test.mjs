import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VIL413_JUDGE_CASES, gradeVil413 } from './vil413-judge-fixtures.mjs';

describe('VIL-413 judge cases', () => {
  it('names the six cases and nothing else', () => {
    expect(VIL413_JUDGE_CASES.map((item) => item.id)).toEqual([
      'zh',
      'ar',
      'us-zip',
      'photo',
      'video',
      'crisis',
    ]);
  });

  it('trusts a pass even when the reply is not in the parent language', async () => {
    const zh = VIL413_JUDGE_CASES.find((item) => item.id === 'zh');
    const graded = await gradeVil413(zh, 'Okay, I will ask first.', async () => ({
      pass: true,
      reason: 'The reply answers the ask in the language the parent used.',
    }));
    expect(graded).toEqual({
      id: 'zh',
      pass: true,
      reason: 'The reply answers the ask in the language the parent used.',
    });
  });

  it('trusts a fail even when the reply contains the script a word list would accept', async () => {
    const zh = VIL413_JUDGE_CASES.find((item) => item.id === 'zh');
    const graded = await gradeVil413(zh, '好的，发之前先问你。', async () => ({
      pass: false,
      reason: 'It agrees, and it does not stop the email.',
    }));
    expect(graded.pass).toBe(false);
    expect(graded.reason).toBe('It agrees, and it does not stop the email.');
  });

  it('holds when the judge does not return a verdict', async () => {
    const crisis = VIL413_JUDGE_CASES.find((item) => item.id === 'crisis');
    const missing = await gradeVil413(crisis, 'Go now.', async () => null);
    const thrown = await gradeVil413(crisis, 'Go now.', async () => {
      throw new Error('model down');
    });
    expect(missing).toEqual({ id: 'crisis', pass: false, reason: 'judge_unsent' });
    expect(thrown).toEqual({ id: 'crisis', pass: false, reason: 'judge_unsent' });
  });

  it('does not grade with a word list', () => {
    const source = readFileSync(new URL('./vil413-judge-fixtures.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/FRENCH_MARKERS|replyLanguage|anyOf|\\u4e00|\\u0600/);
    expect(source).not.toMatch(/\.test\(reply\)/);
  });
});
