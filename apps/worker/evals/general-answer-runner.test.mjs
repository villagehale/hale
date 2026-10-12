import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ANSWER_FIXTURES } from './general-answer-fixtures.mjs';

/**
 * Which fixture each deterministic gate reads, taken off the runner's own report.
 *
 * The runner is a script rather than a module, so its gates are reachable only by running
 * it. `--broken` grades one fixed stand-in body against every fixture with no model call
 * and no recording, which makes the report a pure function of the fixtures and the gates.
 */
const RUNNER = fileURLToPath(new URL('./run-general-answer-eval.mjs', import.meta.url));

/** `{ id: [failure, ...] }` from the report's answers block. */
function failuresById(report) {
  const byId = {};
  let current = null;
  for (const line of report.split('\n')) {
    const answer = line.match(/^(?:PASS|FAIL)\s+(\S+)\s+"/);
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
    report = execFileSync(process.execPath, [RUNNER, '--broken'], { env, encoding: 'utf8' });
    failures = failuresById(report);
  }, 60_000);

  it('asks the casual questions, the two privacy probes and the one health question', () => {
    expect(ANSWER_FIXTURES.map((fixture) => fixture.id)).toEqual([
      'goat-football',
      'im8-supplement',
      'capital-peru',
      'french-capital',
      'solve-3x',
      'boil-egg',
      'pineapple-pizza',
      'poem-mondays',
      'breakfast-unknowable',
      'family-probe',
      'melatonin-adults',
      'fr-pineapple-pizza',
      'zh-goat-football',
    ]);
  });

  it('leaves a pharmacist or doctor pointer on the health question to the judge, and holds every other fixture to the errand gate', () => {
    const health = ANSWER_FIXTURES.filter((fixture) => fixture.healthQuestion);
    expect(health.map((fixture) => fixture.id)).toEqual(['melatonin-adults']);

    const heldToTheErrandGate = Object.keys(failures).filter((id) =>
      failures[id].includes('redirect_errand'),
    );
    expect(heldToTheErrandGate).toEqual(
      ANSWER_FIXTURES.filter((fixture) => !fixture.healthQuestion).map((fixture) => fixture.id),
    );
    // The stand-in body was graded on the health question too: every other gate read it.
    expect(failures['melatonin-adults']).toEqual([
      'over_segment_budget',
      'carries_link',
      'trailing_question',
      'points_at_an_app',
      'judge:1 (calibration stand-in)',
    ]);
  });

  it('has no live-data deflects to compare, and still calibrates', () => {
    expect(report).not.toContain('live-data deflects');
    expect(report).toContain(
      'broken-mode calibration (must fail at least one gate): PASS (exit 0)',
    );
  });
});
