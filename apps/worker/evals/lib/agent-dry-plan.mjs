// --dry projection for agent (coach) turns. The pricing rules are the live guard's, IMPORTED
// from spend-cap.mjs, never copied: a request pays the full rate (cache-write when marked)
// unless warmPrefixTokens() says this process already saw its system prefix written or read
// inside the cache window with nothing in flight. In --dry no call is made, so a projected
// call counts as the write a live call would make (notePrefixUsage with its prefix tokens),
// exactly as the dry judge plan treats its first uncached draw. Calls are serialized.

import {
  cacheAwareWorstUsd,
  cachePrefix,
  notePrefixUsage,
  warmPrefixTokens,
} from '../../../web/lib/testing/spend-cap.mjs';
import { estimateInputTokensOffline } from './harness.mjs';

/**
 * Worst case for the rest of an agent turn that missed the cache at `step`: this step and
 * every step left up to `maxSteps`, input growing by `growthTokens` a step, each with the
 * full max_tokens of output. Returns plan rows; marks the prefix warm as a live call would.
 */
export function projectAgentTurn({
  request,
  step,
  maxSteps,
  growthTokens,
  rates,
  tag,
  now = () => Date.now(),
  estimate = estimateInputTokensOffline,
}) {
  const rows = [];
  const base = estimate(request);
  const prefixTokens = cachePrefix(request)
    ? estimate({ system: request.system, tools: request.tools })
    : 0;
  for (let k = step; k <= maxSteps; k++) {
    const inputTokens = base + (k - step) * growthTokens;
    const startedAt = now();
    const warm = warmPrefixTokens(request, startedAt);
    const worstUsd = cacheAwareWorstUsd(rates, request, inputTokens, warm);
    rows.push({ tag: `${tag}#step${k}`, inputTokens, cacheReadTokens: warm, worstUsd });
    // The write (or read) this call would have made, so the next call may read it.
    notePrefixUsage(
      request,
      warm > 0 ? { cache_read_input_tokens: warm } : { cache_creation_input_tokens: prefixTokens },
      startedAt,
    );
  }
  return rows;
}
