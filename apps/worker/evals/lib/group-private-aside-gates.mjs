// Deterministic gates for evals/run-group-private-aside-eval.mjs (VIL-457 · VIL-554). Pure:
// no model, no network, no web TypeScript, so it is unit-tested on its own
// (group-private-aside-gates.test.mjs). The runner imports these rather than inlining them,
// so the test checks the router `--broken` actually runs.

/** null when `gotRefs` (any order) equals one of the acceptable sets; else the failure line. */
export function routingFailure(sendTo, gotRefs) {
  const got = [...gotRefs].sort().join(',');
  if (sendTo.some((set) => [...set].sort().join(',') === got)) return null;
  return `sendTo:[${got}] expected ${sendTo.map((set) => `[${set.join(',')}]`).join(' or ')}`;
}

/** The --broken router: every family in the chat gets a text, whatever the read said. */
export function brokenRouter(fixture) {
  return fixture.families.map((f) => f.ref);
}

/**
 * A case where texting every family is wrong: no acceptable set is every family. Read from
 * `sendTo` alone, not from routingFailure or brokenRouter, so calibration does not grade the
 * gate and router it is calibrating.
 */
export function overSendingIsWrong(fixture) {
  const every = fixture.families.map((f) => f.ref);
  return !fixture.sendTo.some(
    (set) => set.length === every.length && every.every((ref) => set.includes(ref)),
  );
}

/** Whether a run judges the recorded BROKEN_ASIDE control: always in --broken, else when its fixture is selected. */
export function controlRuns({ mode, only, controlFixture }) {
  return mode === 'broken' || !only || only.includes(controlFixture);
}

/**
 * --broken calibration: (i) at least one selected case is one where over-sending is wrong,
 * (ii) each of those failed routing, (iii) the control ran and the judge failed it.
 * `controlScore` is null when the control did not run, which is not a catch.
 */
export function brokenCalibrated({ fixtures, results, controlScore, judgeMin }) {
  const mustFail = fixtures.filter(overSendingIsWrong).map((f) => f.id);
  const routingCaught =
    mustFail.length > 0 &&
    mustFail.every((id) =>
      results.find((r) => r.id === id)?.failures.some((f) => f.startsWith('sendTo:')),
    );
  return routingCaught && controlScore !== null && controlScore < judgeMin;
}
