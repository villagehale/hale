// The objective half of the coach-bubbles eval: the SHAPE of what the router would send,
// never its wording. Meaning (language, where the question sits, over-splitting) is the
// judge's (run-coach-bubbles-eval.mjs).

const PAGE = /https?:\/\//i;

/**
 * What is wrong with the bubbles a case would send, as named failures. `bubbles` is the
 * router's split of the reply the real post-processor produced. `turn` is what the turn's
 * tools saw: the tools it called, and the offer sentence `offer_full_plan` registered,
 * which code appends to the last bubble.
 */
export function bubbleShapeFailures(bubbles, fixture, turn = { calls: [], offer: null }) {
  const failures = [];
  if (bubbles.length === 0) failures.push('no bubble');
  if (bubbles.some((bubble) => bubble.trim() === '')) failures.push('an empty bubble');
  if (bubbles.slice(0, -1).some((bubble) => PAGE.test(bubble))) {
    failures.push('a page address before the last bubble');
  }
  if (fixture.maxBubbles !== undefined && bubbles.length > fixture.maxBubbles) {
    failures.push(`bubbles: ${bubbles.length}, at most ${fixture.maxBubbles}`);
  }
  for (const name of fixture.neverSays ?? []) {
    const lower = name.toLowerCase();
    if (bubbles.some((bubble) => bubble.toLowerCase().includes(lower))) {
      failures.push(`names "${name}"`);
    }
  }
  for (const tool of fixture.mustCall ?? []) {
    if (!turn.calls.includes(tool)) failures.push(`never called ${tool}`);
  }
  if (turn.offer) {
    if (!(bubbles.at(-1) ?? '').includes(turn.offer)) {
      failures.push('the offer is not in the last bubble');
    }
    const seen = bubbles.join('\n').split(turn.offer).length - 1;
    if (seen > 1 || bubbles.slice(0, -1).some((bubble) => bubble.includes(turn.offer))) {
      failures.push('the offer arrives twice or early');
    }
  }
  return failures;
}
