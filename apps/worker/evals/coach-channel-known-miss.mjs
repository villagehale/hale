/**
 * A fixture may name ONE recorded miss and its ticket (`expect.knownMiss`): a first draw
 * that failed one check, kept as a finding rather than re-drawn until it passed. The miss
 * is printed on every run. It covers the fixture only while the reply fails that check and
 * nothing else; a marked fixture that passes is `stale`, so the marker cannot outlive its
 * fix, and one that fails anything more is `uncovered`, so it cannot hide a new failure.
 *
 * @param {{ expect?: { knownMiss?: { ticket: string, failure: string } } }} fixture
 * @param {string[]} failures
 * @returns {'none' | 'covered' | 'uncovered' | 'stale'}
 */
export function knownMissState(fixture, failures) {
  const miss = fixture.expect?.knownMiss;
  if (!miss) return 'none';
  if (failures.length === 0) return 'stale';
  return failures.every((failure) => failure.includes(miss.failure)) ? 'covered' : 'uncovered';
}
