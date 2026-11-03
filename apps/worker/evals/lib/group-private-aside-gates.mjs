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
