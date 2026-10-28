// Shared eval-runner flag allow-list. Generalized from flood-line-flags.mjs (#926, VIL-463).
// Parsed BEFORE the spend cap or any client exists: an unknown, missing or doubled mode
// throws, the runner exits 2, so a typo such as `--dyr` can never fall through to a live,
// paid run. Live runs need an explicit `--live`.
//
// Whichever of #926 or this PR merges second repoints flood-line to this module and
// deletes apps/worker/evals/flood-line-flags.mjs.

import { PRICE } from './harness.mjs';

export const EVAL_MODES = ['--dry', '--broken', '--cached-only', '--live'];

/** @returns {'dry' | 'broken' | 'cached-only' | 'live'} */
export function parseEvalFlags(args) {
  const unknown = args.filter((a) => !EVAL_MODES.includes(a));
  if (unknown.length > 0) {
    throw new Error(`unknown flag(s): ${unknown.join(' ')}. Allowed: ${EVAL_MODES.join(' ')}`);
  }
  if (args.length !== 1) {
    throw new Error(`pass exactly one mode: ${EVAL_MODES.join(' | ')} (live needs --live)`);
  }
  return args[0].slice(2);
}

/** Parse, or print the reason and exit 2. Call first thing in main(). */
export function parseEvalFlagsOrExit(name, args = process.argv.slice(2)) {
  try {
    return parseEvalFlags(args);
  } catch (err) {
    console.error(`${name} eval: ${err.message}`);
    process.exit(2);
  }
}

/** A getClient for every mode but --live: any attempt to reach a model throws. */
export function noClient(name) {
  return () => {
    throw new Error(`${name}: a model call was attempted outside --live`);
  };
}

/** Offline input-token estimate (1 token per 3 bytes, deliberately high). */
export const estimateTokens = (text) => Math.ceil(text.length / 3);

/** Worst-case USD for one call at list price with the full output cap spent. */
export function worstCaseUsd(model, inTokens, maxOut) {
  const rates = PRICE[model];
  if (!rates) throw new Error(`no price for ${model}`);
  return (inTokens / 1e6) * rates.input + (maxOut / 1e6) * rates.output;
}
