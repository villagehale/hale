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
const FIXTURES_URL = new URL('./general-answer-fixtures.mjs', import.meta.url).href;

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

/**
 * A module loaded ahead of the runner that changes what one recording REPLAYS AS, in
 * memory, as the runner reads it. The file on disk is not touched, and no model is
 * called: it is how a test asks "what does the runner do with THIS verdict" of a script
 * that takes its verdicts from the committed recordings.
 *
 * `scores` gives the judge's verdicts new scores by the order the runner reads them: the
 * broken stand-in's is the first, the near miss's the second, then one per fixture. `*`
 * is every verdict not named. `sanitizedQuestion` is appended to the question in the
 * first sanitize recording read.
 */
function replayedAs({ scores = {}, sanitizedQuestion = '' }) {
  return `data:text/javascript,${encodeURIComponent(
    `import fs from 'node:fs/promises';
     import { syncBuiltinESMExports } from 'node:module';
     const scores = ${JSON.stringify(scores)};
     const appended = ${JSON.stringify(sanitizedQuestion)};
     const read = fs.readFile;
     let verdicts = 0;
     let sanitized = 0;
     fs.readFile = async (path, ...rest) => {
       const text = await read(path, ...rest);
       if (!String(path).includes('/evals/cache/')) return text;
       const recorded = JSON.parse(text);
       if (typeof recorded?.parsed?.score === 'number') {
         verdicts += 1;
         const score = scores[verdicts] ?? scores['*'];
         return score === undefined
           ? text
           : JSON.stringify({ ...recorded, parsed: { ...recorded.parsed, score } });
       }
       if (appended !== '' && typeof recorded?.value?.question === 'string') {
         sanitized += 1;
         if (sanitized === 1) {
           const question = recorded.value.question + appended;
           return JSON.stringify({ ...recorded, value: { ...recorded.value, question } });
         }
       }
       return text;
     };
     syncBuiltinESMExports();`,
  )}`;
}

/** A module loaded ahead of the runner that cuts the corpus down to the fixtures named. */
function onlyFixtures(ids) {
  return `data:text/javascript,${encodeURIComponent(
    `import { ANSWER_FIXTURES } from ${JSON.stringify(FIXTURES_URL)};
     const keep = ${JSON.stringify(ids)};
     ANSWER_FIXTURES.splice(0, ANSWER_FIXTURES.length, ...ANSWER_FIXTURES.filter((fixture) => keep.includes(fixture.id)));`,
  )}`;
}

/** The runner as a process over the committed recordings: no API key, no model call. */
function runRunner(args, preloads = []) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  const run = spawnSync(
    process.execPath,
    [...preloads.flatMap((preload) => ['--import', preload]), RUNNER, ...args, '--cached-only'],
    { env, encoding: 'utf8' },
  );
  return { status: run.status, report: `${run.stdout}${run.stderr}` };
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

  /**
   * The same check where the runner makes it. The function above can be right and the
   * runner still never call it, so this replays the whole corpus from the committed
   * recordings with one more town marked on the fixture whose search names Oakville: a
   * town that request does not carry. A module loaded ahead of the runner marks it, on
   * the fixture list the runner then imports. No API key, no model call.
   */
  it('fails the fixture in a real run when the search request leaves a marked town out', () => {
    const unsentTown = 'milton';
    const markOneMore = `data:text/javascript,${encodeURIComponent(
      `import { ANSWER_FIXTURES } from ${JSON.stringify(FIXTURES_URL)};
       ANSWER_FIXTURES.find((fixture) => fixture.id === 'street-address-costco').mustReachSearch.push(${JSON.stringify(unsentTown)});`,
    )}`;
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const run = spawnSync(process.execPath, ['--import', markOneMore, RUNNER, '--cached-only'], {
      env,
      encoding: 'utf8',
    });
    const realReport = `${run.stdout}${run.stderr}`;
    const realFailures = failuresById(realReport);

    expect(realFailures['street-address-costco']).toContain(`not_sent_to_search:${unsentTown}`);
    expect(realFailures['street-address-costco']).not.toContain('not_sent_to_search:oakville');
    expect(realReport).toMatch(/^named town not searched: +1 {2}\(0 required/m);
  }, 60_000);

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

  /**
   * THE GATE IS THE EXIT CODE, which is what CI reads. The tests above read the report,
   * and a report can say FAIL while the process exits 0. So each term of the gate is
   * moved on its own here and the exit code is what is asserted. Every verdict is given
   * a score, so what is pinned is the runner's arithmetic and not how this recording
   * happened to be judged: both stand-ins failed (1) and every fixture passed (5) is the
   * state that must exit 0, and each run below changes one thing from it.
   */
  describe('the gate, by exit code', () => {
    const HOLDS = { 1: 1, 2: 1, '*': 5 };
    const PASSING = 5;
    const FAILING = 1;
    // The calibration fixture has to be in the corpus: the stand-ins are graded on it.
    const CORPUS = onlyFixtures(['leafs-last-night', 'capital-peru']);

    it('exits 0 in broken mode when the judge fails both stand-ins', () => {
      const run = runRunner(['--broken'], [replayedAs({ scores: HOLDS })]);

      expect(run.report).toContain(
        'broken-mode calibration (the judge must fail both stand-ins): PASS (exit 0)',
      );
      expect(run.status).toBe(0);
    });

    it.each([
      ['the broken stand-in', 1],
      ['the near miss', 2],
    ])('exits 1 in broken mode when the judge passes %s', (_label, verdict) => {
      const run = runRunner(
        ['--broken'],
        [replayedAs({ scores: { ...HOLDS, [verdict]: PASSING } })],
      );

      // Positive control: the run got as far as its gate, and it is this stand-in that
      // passed. A cache miss exits 1 too.
      expect(run.report).not.toContain('cache miss');
      expect(run.report).toMatch(/broken-mode calibration .*: FAIL \(exit 1\)/);
      const graded = [...run.report.matchAll(/^(PASS|FAIL) {2}(\S+)/gm)].map(([, tag, id]) => [
        id,
        tag,
      ]);
      expect(graded).toEqual([
        ['leafs-last-night', verdict === 1 ? 'PASS' : 'FAIL'],
        ['leafs-last-night:near-miss', verdict === 2 ? 'PASS' : 'FAIL'],
      ]);
      expect(run.status).toBe(1);
    });

    it('exits 0 in the real mode when the calibration holds and every fixture passes', () => {
      const run = runRunner([], [CORPUS, replayedAs({ scores: HOLDS })]);

      expect(run.report).toContain('corpus: 2 questions');
      expect(run.report).toContain('overall (real): PASS (exit 0)');
      expect(run.status).toBe(0);
    });

    it.each([
      ['the judge passes the broken stand-in', { 1: PASSING }],
      ['the judge passes the near miss', { 2: PASSING }],
      ['one fixture is below the pass mark', { 3: FAILING }],
    ])('exits 1 in the real mode when %s, and nothing else is wrong', (_label, change) => {
      const run = runRunner([], [CORPUS, replayedAs({ scores: { ...HOLDS, ...change } })]);

      expect(run.report).not.toContain('cache miss');
      expect(run.report).toContain('overall (real): FAIL (exit 1)');
      // Only the term this run moved is wrong.
      expect(run.report).toMatch(
        new RegExp(`^judge below 4: +${'3' in change ? 1 : 0} {2}\\(0 required\\)$`, 'm'),
      );
      expect(run.status).toBe(1);
    });
  });

  /**
   * The runner's own call to production's identifier scrub, between the sanitize
   * recording and everything handed on. No recorded question has an identifier left in
   * it, so the call changes nothing on the corpus and could be deleted unseen. Here one
   * is put into the sanitize stage's replayed question, and what the runner hands the
   * search is read off the cache key it then asks for: a question that left the sanitizer
   * with a phone number in it, and the same question with that number already taken out,
   * must be the SAME request.
   */
  it('scrubs what the sanitize stage wrote before it is handed to the search', () => {
    const searchKey = (sanitizedQuestion) => {
      const run = runRunner(['--broken'], [replayedAs({ sanitizedQuestion })]);
      const miss = run.report.match(
        /cache miss in --cached-only mode \(general-answer-search:leafs-last-night, key ([0-9a-f]{64})\)/,
      );
      expect(miss, run.report).not.toBeNull();
      return miss[1];
    };

    const withNumber = searchKey(', text me at 416-555-0142');
    const alreadyScrubbed = searchKey(', text me at [redacted]');
    // Positive control: the key does follow the question.
    const otherWords = searchKey(', text me back');

    expect(withNumber).toBe(alreadyScrubbed);
    expect(otherWords).not.toBe(alreadyScrubbed);
  });
});

