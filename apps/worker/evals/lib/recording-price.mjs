/**
 * Price one recording the way `run-general-answer-eval.mjs --estimate` does.
 *
 * A cached prefix is written once at 1.25× the input price and read after that at
 * 0.1×. The user message stays at 1×. A call with no cache breakpoint pays 1× for
 * its whole prefix every time. `thinkingTokens` on a call replaces the default
 * (the median thinking tokens); `0` means the lane does not add them.
 */
export function priceRecordedCalls(recorded, { priceFor, tokens, thinkingTokens }) {
  const wrote = new Set();
  const byModel = {};
  let usd = 0;
  for (const call of recorded) {
    const price = priceFor(call.model);
    if (!price) throw new Error(`estimate: no price for ${call.model}`);
    const userTokens = tokens(call.user.length);
    const prefixTokens = tokens(call.prefix.length);
    const bucket = byModel[call.model] ?? {
      fresh: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    };
    byModel[call.model] = bucket;
    let billedInput = userTokens;
    bucket.fresh += userTokens;
    if (call.promptCache) {
      if (wrote.has(call.prefixId)) {
        bucket.cacheRead += prefixTokens;
        billedInput += prefixTokens * 0.1;
      } else {
        wrote.add(call.prefixId);
        bucket.cacheWrite += prefixTokens;
        billedInput += prefixTokens * 1.25;
      }
    } else {
      bucket.fresh += prefixTokens;
      billedInput += prefixTokens;
    }
    const outputTokens = tokens(call.outputChars) + (call.thinkingTokens ?? thinkingTokens);
    bucket.output += outputTokens;
    usd += (billedInput / 1e6) * price.input + (outputTokens / 1e6) * price.output;
  }
  return { usd, byModel };
}
