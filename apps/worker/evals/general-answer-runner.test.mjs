import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ANSWER_FIXTURES, EVAL_TODAY, identityLeaks } from './general-answer-fixtures.mjs';

/**
 * What grades a reply in this suite, taken off the runner's own report.
 *
 * The runner is a script rather than a module, so its grading is reachable only by
 * running it. `--broken` grades one fixed stand-in reply on one searched fixture, with
 * the real judge replayed from the committed recording: no API key, no model call.
 */
const RUNNER = fileURLToPath(new URL('./run-general-answer-eval.mjs', import.meta.url));

/** `{ id: [failure, ...] }` from the report's answers block. */
function failuresById(report) {
  const byId = {};
  let current = null;
  for (const line of report.split('\n')) {
    const answer = line.match(/^(?:PASS|FAIL)\s+(\S+)\s/);
    if (answer) {
      current = answer[1];
      byId[current] = [];
      continue;
    }
    const failure = line.match(/^\s+· (.+)$/);
    if (failure && current) byId[current].push(failure[1]);
  }
  return byId;
}

describe('the general-answer runner', () => {
  let report;
  let failures;

  beforeAll(() => {
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const run = spawnSync(process.execPath, [RUNNER, '--broken', '--cached-only'], {
      env,
      encoding: 'utf8',
    });
    report = `${run.stdout}${run.stderr}`;
    failures = failuresById(report);
  }, 60_000);

  it('asks the casual questions, the live lookups, the privacy probes and the health question', () => {
    expect(ANSWER_FIXTURES.map((fixture) => fixture.id)).toEqual([
      'goat-football',
      'im8-supplement',
      'weather-tomorrow',
      'leafs-last-night',
      'gas-price-now',
      'tsx-today',
      'stream-euros',
      'capital-peru',
      'french-capital',
      'solve-3x',
      'boil-egg',
      'pm-canada',
      'best-minivan',
      'pineapple-pizza',
      'poem-mondays',
      'breakfast-unknowable',
      'family-probe',
      'melatonin-adults',
      'score-search-off',
      'goat-search-off',
      'named-neighbour-score',
      'fr-pineapple-pizza',
      'zh-goat-football',
    ]);
  });

  /**
   * Barton, 2026-10-12: the judge on correctness and tone, with no word or length
   * checks. A fixture is a question and what a right answer to it is. A field a
   * deterministic reply gate would read (a pattern, a recall list, a hedge list) has
   * nothing left to read it.
   */
  it('gives a fixture nothing a word or length check could read', () => {
    const allowed = new Set(['id', 'text', 'watchFor', 'searchOff', 'mustNotReachSearch']);
    const extra = ANSWER_FIXTURES.flatMap((fixture) =>
      Object.keys(fixture)
        .filter((key) => !allowed.has(key))
        .map((key) => `${fixture.id}.${key}`),
    );
    expect(extra).toEqual([]);
    expect(ANSWER_FIXTURES.filter((fixture) => !fixture.watchFor).map((f) => f.id)).toEqual([]);
  });

  it('runs two fixtures with the search off and marks one name that must not reach the search', () => {
    expect(ANSWER_FIXTURES.filter((fixture) => fixture.searchOff).map((f) => f.id)).toEqual([
      'score-search-off',
      'goat-search-off',
    ]);
    expect(
      ANSWER_FIXTURES.filter((fixture) => fixture.mustNotReachSearch).map((fixture) => [
        fixture.id,
        fixture.mustNotReachSearch,
      ]),
    ).toEqual([['named-neighbour-score', ['priya']]]);
  });

  /**
   * The one check that is not the judge's, on its own: a marked name still in what the
   * sanitize stage handed on is a failure, in any case, and a clean question is not.
   */
  it('fails a marked name that is still in the de-identified question, and only then', () => {
    const marked = { mustNotReachSearch: ['priya'] };

    expect(identityLeaks(marked, 'did Priya say the jays won last night')).toEqual([
      'identity_leak:priya',
    ]);
    expect(identityLeaks(marked, 'did the jays win last night')).toEqual([]);
    expect(identityLeaks({}, 'did Priya say the jays won last night')).toEqual([]);
  });

  /** The search is live when recorded and replayed after, so the day it was recorded on
   * is pinned in the shape answer.ts's localDate writes. */
  it('pins the day the corpus was recorded', () => {
    expect(EVAL_TODAY).toBe('monday, oct 12, 2026');
  });

  /**
   * The stand-in states a result with total confidence, points at the app, carries a
   * link and ends on a question. Every one of those used to trip a pattern. Now there is
   * one grader, and it is the one that reads the research: the judge.
   */
  it('fails the broken stand-in on the judge alone', () => {
    expect(Object.keys(failures)).toEqual(['leafs-last-night']);
    expect(failures['leafs-last-night']).toHaveLength(1);
    expect(failures['leafs-last-night'][0]).toMatch(/^judge:[123] \(.+\)$/);
    expect(report).toContain(
      'broken-mode calibration (the judge must fail the stand-in): PASS (exit 0)',
    );
  });
});
