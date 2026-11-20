import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergeReadyReasons } from './merge-ready.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'merge-ready.mjs');

const ready = {
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  behindBy: 0,
  stacked: false,
  stackNumber: null,
  mainCi: {
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.test/run/1',
    headSha: 'abc',
  },
};

describe('mergeReadyReasons', () => {
  it('passes a PR that is current with main, unstacked, and on a green main', () => {
    expect(mergeReadyReasons(ready)).toEqual([]);
  });

  it('refuses a PR that is behind main', () => {
    expect(mergeReadyReasons({ ...ready, behindBy: 2 })).toEqual([
      'PR is behind main by 2 commits',
    ]);
    expect(mergeReadyReasons({ ...ready, behindBy: 1 })).toEqual(['PR is behind main by 1 commit']);
    expect(mergeReadyReasons({ ...ready, mergeStateStatus: 'BEHIND' })).toEqual([
      'PR is behind main',
    ]);
  });

  it('does not treat behind-the-base as behind main when the base is not main', () => {
    expect(
      mergeReadyReasons({
        ...ready,
        baseRefName: 'feature',
        mergeStateStatus: 'BEHIND',
        behindBy: 0,
      }),
    ).toEqual([]);
  });

  it('refuses a PR that conflicts with main', () => {
    expect(mergeReadyReasons({ ...ready, mergeable: 'CONFLICTING' })).toEqual([
      'PR conflicts with main',
    ]);
    expect(mergeReadyReasons({ ...ready, mergeStateStatus: 'DIRTY' })).toEqual([
      'PR conflicts with main',
    ]);
  });

  it('does not call a conflict with another base a conflict with main', () => {
    expect(
      mergeReadyReasons({ ...ready, baseRefName: 'feature', mergeable: 'CONFLICTING' }),
    ).toEqual([]);
  });

  it('refuses when mergeability with main never resolves', () => {
    expect(mergeReadyReasons({ ...ready, mergeable: 'UNKNOWN' })).toEqual([
      'PR mergeability with main is unknown',
    ]);
  });

  it('refuses a PR on a native stack', () => {
    expect(mergeReadyReasons({ ...ready, stacked: true, stackNumber: 4 })).toEqual([
      'PR is part of native stack #4',
    ]);
    expect(mergeReadyReasons({ ...ready, stacked: true, stackNumber: null })).toEqual([
      'PR is part of a native stack',
    ]);
  });

  it('refuses when main CI is red and ignores a run that is still going', () => {
    expect(
      mergeReadyReasons({
        ...ready,
        mainCi: {
          status: 'completed',
          conclusion: 'failure',
          url: 'https://example.test/run/9',
          headSha: 'deadbeef',
        },
      }),
    ).toEqual(["main's latest CI is red (failure) sha deadbeef https://example.test/run/9"]);
    for (const conclusion of ['timed_out', 'startup_failure', 'action_required']) {
      expect(
        mergeReadyReasons({
          ...ready,
          mainCi: { status: 'completed', conclusion, url: '', headSha: '' },
        })[0],
      ).toContain(`main's latest CI is red (${conclusion})`);
    }
    expect(
      mergeReadyReasons({
        ...ready,
        mainCi: { status: 'in_progress', conclusion: '', url: '', headSha: 'abc' },
      }),
    ).toEqual([]);
    expect(
      mergeReadyReasons({
        ...ready,
        mainCi: { status: 'completed', conclusion: 'cancelled', url: '', headSha: '' },
      }),
    ).toEqual([]);
  });

  it('refuses when main has no CI run', () => {
    expect(mergeReadyReasons({ ...ready, mainCi: null })).toEqual([
      "main's latest CI run is missing",
    ]);
  });

  it('prints every reason together', () => {
    expect(
      mergeReadyReasons({
        ...ready,
        behindBy: 3,
        mergeable: 'CONFLICTING',
        stacked: true,
        stackNumber: 8,
        mainCi: { status: 'completed', conclusion: 'failure', url: '', headSha: '' },
      }),
    ).toEqual([
      'PR is part of native stack #8',
      'PR is behind main by 3 commits',
      'PR conflicts with main',
      "main's latest CI is red (failure)",
    ]);
  });
});

describe('merge-ready CLI', () => {
  it('exits 2 when the PR number is missing', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: node scripts/ci/merge-ready.mjs <pr-number>');
  });
});
