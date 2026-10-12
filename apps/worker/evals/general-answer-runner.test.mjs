import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ANSWER_FIXTURES,
  EVAL_TODAY,
  identityLeaks,
  searchOmissions,
} from './general-answer-fixtures.mjs';

/**
 * What grades a reply in this suite, taken off the runner's own report.
 *
 * The runner is a script rather than a module, so its grading is reachable only by
 * running it. `--broken` grades two stand-in replies on one searched fixture, with the
 * real judge replayed from the committed recording: no API key, no model call.
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
      'weather-tomorrow-home',
      'weather-tomorrow-home-us',
      'weather-other-city',
      'weather-search-off',
      'leafs-last-night',
      'gas-price-now',
      'tsx-today',
      'mortgage-rate',
      'mortgage-rate-home',
      'stream-euros',
      'capital-peru',
      'french-capital',
      'solve-3x',
      'boil-egg',
      'world-series-20-years',
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
      'nap-question',
      'need-a-therapist',
      'need-a-therapist-home',
      'vent-exhausted',
      'pending-city-reply',
      'pending-unrelated',
      'named-child-game',
      'named-school-rain',
      'street-address-costco',
      'phone-number-game',
      'injected-notes',
      'fr-pineapple-pizza',
      'zh-goat-football',
    ]);
  });

  /**
   * Barton, 2026-10-12: the judge on correctness and tone, with no word or length
   * checks. A fixture is a question and what a right answer to it is. A field a
   * deterministic reply gate would read (a pattern, a recall list, a hedge list) has
   * nothing left to read it. The other fields set the turn up (the flag, the family's
   * place, a pending ask, a supplied search result) or check what was handed on to the
   * search, never the reply.
   */
  it('gives a fixture nothing a word or length check could read', () => {
    const allowed = new Set([
      'id',
      'text',
      'watchFor',
      'searchOff',
      'place',
      'pending',
      'expectAnswersPending',
      'research',
      'mustNotReachSearch',
      'mustReachSearch',
    ]);
    const extra = ANSWER_FIXTURES.flatMap((fixture) =>
      Object.keys(fixture)
        .filter((key) => !allowed.has(key))
        .map((key) => `${fixture.id}.${key}`),
    );
    expect(extra).toEqual([]);
    expect(ANSWER_FIXTURES.filter((fixture) => !fixture.watchFor).map((f) => f.id)).toEqual([]);
  });

  it('runs three fixtures with the search off and marks what must not reach the search', () => {
    expect(ANSWER_FIXTURES.filter((fixture) => fixture.searchOff).map((f) => f.id)).toEqual([
      'weather-search-off',
      'score-search-off',
      'goat-search-off',
    ]);
    // A neighbour's name, a child's name, a school, a street, a phone number, and the
    // family's own city on a question that names another one. All invented.
    expect(
      ANSWER_FIXTURES.filter((fixture) => fixture.mustNotReachSearch).map((fixture) => [
        fixture.id,
        fixture.mustNotReachSearch,
      ]),
    ).toEqual([
      ['weather-other-city', ['toronto']],
      ['named-neighbour-score', ['priya']],
      ['named-child-game', ['theo']],
      ['named-school-rain', ['fernhollow']],
      ['street-address-costco', ['maplewick']],
      ['phone-number-game', ['555-0142', '5550142']],
    ]);
  });

  /** The family's place and a pending ask are the lane's to supply, so a fixture says
   * what the lane would have read. */
  it('sets up the turns that depend on the family place and on a pending ask', () => {
    expect(ANSWER_FIXTURES.filter((fixture) => fixture.place).map((f) => [f.id, f.place])).toEqual([
      ['weather-tomorrow-home', { city: 'Toronto', country: 'Canada' }],
      ['weather-tomorrow-home-us', { city: 'Denver', country: 'United States' }],
      ['weather-other-city', { city: 'Toronto', country: 'Canada' }],
      ['mortgage-rate-home', { city: 'Toronto', country: 'Canada' }],
      ['need-a-therapist-home', { city: 'Toronto', country: 'Canada' }],
    ]);
    expect(
      ANSWER_FIXTURES.filter((fixture) => fixture.pending).map((f) => [
        f.id,
        f.expectAnswersPending,
      ]),
    ).toEqual([
      ['pending-city-reply', true],
      ['pending-unrelated', false],
    ]);
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

  /**
   * Sloane's finding 3, the other direction. The town a parent names is the place their
   * question is about, so it has to be in the request the search was sent. A turn that
   * made no search sent it nowhere.
   */
  it('fails a marked town the search was not sent, and only then', () => {
    const marked = { mustReachSearch: ['oakville'] };
    const sent = (question) => JSON.stringify({ question, today: EVAL_TODAY });

    expect(searchOmissions(marked, sent('where is the closest costco'))).toEqual([
      'not_sent_to_search:oakville',
    ]);
    expect(searchOmissions(marked, '')).toEqual(['not_sent_to_search:oakville']);
    expect(searchOmissions(marked, sent('where is the closest Costco in Oakville'))).toEqual([]);
    expect(searchOmissions({}, '')).toEqual([]);
    expect(
      ANSWER_FIXTURES.filter((fixture) => fixture.mustReachSearch).map((fixture) => [
        fixture.id,
        fixture.mustReachSearch,
      ]),
    ).toEqual([['street-address-costco', ['oakville']]]);
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
    expect(failures['leafs-last-night']).toHaveLength(1);
    expect(failures['leafs-last-night'][0]).toMatch(/^judge:[123] \(.+\)$/);
  });

  /**
   * Sloane's finding 8. The broken stand-in is wrong about everything, so a judge that
   * fails it has only been shown to catch a gross break. The near miss is the suite's own
   * correct reply with an assistant's sign-off after it: right facts, wrong voice. The
   * judge has to fail that one too, or nothing holds the friend-texting bar.
   */
  it('fails the near miss, a correct answer with an assistant sign-off, on the judge alone', () => {
    expect(Object.keys(failures)).toEqual(['leafs-last-night', 'leafs-last-night:near-miss']);
    expect(failures['leafs-last-night:near-miss']).toHaveLength(1);
    expect(failures['leafs-last-night:near-miss'][0]).toMatch(/^judge:[123] \(.+\)$/);
    expect(report).toContain('Want me to check anything else for you?');
    expect(report).toContain(
      'broken-mode calibration (the judge must fail both stand-ins): PASS (exit 0)',
    );
  });
});
