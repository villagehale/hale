import { describe, expect, it } from 'vitest';
import { GROUP_PRIVATE_ASIDE_FIXTURES } from '../group-private-aside-fixtures.mjs';
import {
  brokenCalibrated,
  brokenRouter,
  controlRuns,
  overSendingIsWrong,
  routingFailure,
} from './group-private-aside-gates.mjs';

/**
 * The deterministic half of evals/run-group-private-aside-eval.mjs (VIL-457 / VIL-554):
 * the routing gate, and the over-sending router `--broken` runs it against.
 */
describe('routingFailure', () => {
  it('accepts the expected set in any order', () => {
    expect(routingFailure([['f1', 'f2']], ['f2', 'f1'])).toBeNull();
  });

  it('names the over-send #934 logged before its adjacency fix', () => {
    expect(routingFailure([['f3']], ['f1', 'f2', 'f3'])).toBe('sendTo:[f1,f2,f3] expected [f3]');
  });

  it('treats an empty set as "nobody gets a text"', () => {
    expect(routingFailure([[]], [])).toBeNull();
    expect(routingFailure([[]], ['f1'])).toBe('sendTo:[f1] expected []');
  });

  it('lists every acceptable set when none matches', () => {
    expect(routingFailure([['f1'], []], ['f2'])).toBe('sendTo:[f2] expected [f1] or []');
  });
});

describe('brokenRouter against the real fixtures', () => {
  it('fails routing on every case where texting every family is wrong', () => {
    const failing = GROUP_PRIVATE_ASIDE_FIXTURES.filter(
      (f) => routingFailure(f.sendTo, brokenRouter(f)) !== null,
    ).map((f) => f.id);
    expect(failing).toEqual([
      'en-own-card-asked-in-group',
      'en-other-family-asks-about-kid',
      'fr-clash-one-of-three',
      'zh-public-logistics',
      'en-name-in-chatter',
      'en-repeat-held-back',
      'en-real-change-sent',
    ]);
  });

  it('positive control: each case passes routing with its own expected set', () => {
    for (const f of GROUP_PRIVATE_ASIDE_FIXTURES) {
      expect(routingFailure(f.sendTo, f.sendTo[0]), f.id).toBeNull();
    }
  });
});

// Brief D1 (i)-(iii). Hand-derived from the fixtures' sendTo: every case but en-clash-two-families
// expects fewer than every family, so the over-sending router must fail its routing there.
const MUST_FAIL = [
  'en-own-card-asked-in-group',
  'en-other-family-asks-about-kid',
  'fr-clash-one-of-three',
  'zh-public-logistics',
  'en-name-in-chatter',
  'en-repeat-held-back',
  'en-real-change-sent',
];
const caught = (ids) =>
  GROUP_PRIVATE_ASIDE_FIXTURES.map((f) => ({
    id: f.id,
    failures: ids.includes(f.id) ? ['sendTo:[f1,f2] expected []'] : [],
  }));

describe('overSendingIsWrong', () => {
  it('is true exactly where no acceptable set is every family', () => {
    expect(GROUP_PRIVATE_ASIDE_FIXTURES.filter(overSendingIsWrong).map((f) => f.id)).toEqual(
      MUST_FAIL,
    );
  });
});

describe('brokenCalibrated', () => {
  const all = { fixtures: GROUP_PRIVATE_ASIDE_FIXTURES, judgeMin: 4 };

  it('positive control: passes when every must-fail case failed routing and the control is caught', () => {
    expect(brokenCalibrated({ ...all, results: caught(MUST_FAIL), controlScore: 1 })).toBe(true);
  });

  it('fails when the gate let one must-fail case through (a lenient routing gate)', () => {
    const results = caught(MUST_FAIL.filter((id) => id !== 'fr-clash-one-of-three'));
    expect(brokenCalibrated({ ...all, results, controlScore: 1 })).toBe(false);
  });

  it('fails when a must-fail case failed on something other than routing', () => {
    const results = caught(MUST_FAIL).map((r) =>
      r.id === 'zh-public-logistics' ? { ...r, failures: ['judge:f1:2 (x)'] } : r,
    );
    expect(brokenCalibrated({ ...all, results, controlScore: 1 })).toBe(false);
  });

  it('fails when no selected case is one where over-sending is wrong', () => {
    const fixtures = GROUP_PRIVATE_ASIDE_FIXTURES.filter((f) => f.id === 'en-clash-two-families');
    const results = [{ id: 'en-clash-two-families', failures: [] }];
    expect(brokenCalibrated({ fixtures, results, controlScore: 1, judgeMin: 4 })).toBe(false);
  });

  it('fails when the control was not caught by the judge', () => {
    expect(brokenCalibrated({ ...all, results: caught(MUST_FAIL), controlScore: 4 })).toBe(false);
  });

  it('fails when the control did not run', () => {
    expect(brokenCalibrated({ ...all, results: caught(MUST_FAIL), controlScore: null })).toBe(
      false,
    );
  });
});

describe('controlRuns', () => {
  const controlFixture = 'en-clash-two-families';

  it('always runs the control in --broken, whatever --only selects', () => {
    expect(controlRuns({ mode: 'broken', only: ['fr-clash-one-of-three'], controlFixture })).toBe(
      true,
    );
  });

  it('in other modes runs it only when its fixture is selected (positive and negative)', () => {
    expect(controlRuns({ mode: 'cached-only', only: null, controlFixture })).toBe(true);
    expect(controlRuns({ mode: 'cached-only', only: [controlFixture], controlFixture })).toBe(true);
    expect(
      controlRuns({ mode: 'cached-only', only: ['fr-clash-one-of-three'], controlFixture }),
    ).toBe(false);
  });
});
