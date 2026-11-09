// Cached-only expected-fail gate for the said-line eval (mirrors run-reminder-eval.mjs on #914).
// Kept in its own module so tests can import it without running the eval's main().

/**
 * Cached-only expected-fail list (VIL-608,
 * https://linear.app/villagehale/issue/VIL-608). The first full recording on main fails these
 * four, and the judge is right on each: three mark the parent's gender in French or Spanish
 * (the skill already forbids it), and health-unknown-en reads like a policy notice. The fix
 * belongs in the writer. Remove each id once it passes; a listed case that passes turns the
 * check red so the list can never go stale. Live runs ignore this list.
 */
export const EXPECTED_FAIL = Object.freeze([
  'identity-fr',
  'intro-no-es',
  'intro-soft-close-es-no-tag',
  'health-unknown-en',
]);

/**
 * Every run case must pass except the ones on `expectedFail`, which must still fail. A listed
 * id that names no fixture at all is an error (renamed or removed fixture).
 * @param {{ id: string, failed: boolean }[]} results
 * @param {readonly string[]} expectedFail
 * @param {readonly string[]} knownIds every fixture id (defaults to the ids in `results`)
 */
export function expectedFailGate(results, expectedFail, knownIds = results.map((r) => r.id)) {
  const listed = new Set(expectedFail);
  const known = new Set(knownIds);
  const unexpectedFail = results.filter((r) => r.failed && !listed.has(r.id)).map((r) => r.id);
  const unexpectedPass = results.filter((r) => !r.failed && listed.has(r.id)).map((r) => r.id);
  const expectedFailed = results.filter((r) => r.failed && listed.has(r.id)).map((r) => r.id);
  const unknown = expectedFail.filter((id) => !known.has(id));
  const lines = [];
  if (expectedFailed.length > 0)
    lines.push(`expected-fail (VIL-608, still failing as listed): ${expectedFailed.join(', ')}`);
  if (unexpectedFail.length > 0)
    lines.push(`FAIL unexpected failures: ${unexpectedFail.join(', ')}`);
  if (unexpectedPass.length > 0)
    lines.push(
      `FAIL expected-fail case now passes, remove it from EXPECTED_FAIL (VIL-608): ${unexpectedPass.join(', ')}`,
    );
  if (unknown.length > 0)
    lines.push(`FAIL EXPECTED_FAIL lists unknown case ids: ${unknown.join(', ')}`);
  const ok = unexpectedFail.length === 0 && unexpectedPass.length === 0 && unknown.length === 0;
  return { ok, unexpectedFail, unexpectedPass, unknown, expectedFailed, lines };
}
