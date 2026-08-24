import type { AgentClient } from '@hale/agent';
import { activityClient } from '~/lib/pipeline/client';
import type { DeepFailure, DeepResult } from './deep';
import type { ActivityQuery } from './deidentify';
import type { FollowUpEvidence } from './deliver';
import { type AngleResearcher, type FanOutResult, createAngleResearcher, runFanOut } from './fanout';
import { type RefutationResult, refuteSlots } from './refute';
import { type SynthesisOutcome, type Synthesiser, createSynthesiser } from './synthesis';

/**
 * THE DEEP LANE — fan out, merge, refute. The whole instrument in one call.
 *
 * WHAT IT IS FOR. A parent names a gym at 19:40 and asks when the fall term starts. The
 * inline turn has thirty seconds and answers with what a search engine chose to show it;
 * this lane runs two minutes later, opens nine pages across three angles at once, merges
 * them into rows, and tries to break every row before a word is composed. The parent gets
 * a second text with the day, the fee and the registration date on it — facts that are on
 * a page somebody opened, quoted, and checked.
 *
 * THREE STAGES, AND EACH ONE CAN ONLY WEAKEN THE CLAIM:
 *
 *   FAN OUT (fanout.ts) — three concurrent research legs. Wall clock is the slowest leg.
 *   SYNTHESIS (synthesis.ts) — one Opus turn merges them into rows, each fact beside the
 *     verbatim span it was read off.
 *   REFUTE (refute.ts) — deterministic. A row citing a page nobody opened is dropped; a
 *     fact whose span is not on the page it cites is dropped. Both counted.
 *
 * IT SPEAKS THE EXISTING VOCABULARY on purpose. What comes out is a {@link DeepResult} —
 * the same three-way answer the single-leg pass returns (deep.ts) and the same one the
 * composer, the share page and the sweep's counters already read. A richer lane behind an
 * unchanged contract is a lane that can be swapped, compared and rolled back; a new result
 * type would have meant a new reader in five places and a new way for `read` and `unread`
 * to be confused, which is the benchmark defect.
 *
 * `unread` IS REACHABLE AND MEANS WHAT IT SAYS: every leg searched and every fetch was
 * refused. The lane knows nothing about what those pages carry, so it composes nothing
 * about them (rule #11).
 */

export interface DeepLaneDeps {
  researcher: AngleResearcher;
  synthesiser: Synthesiser;
}

/**
 * The audit row's counts, widened for this lane. Everything the sweep's row carries plus
 * what only a fan-out has: how many angles came back, and how much the adversarial pass
 * threw away.
 *
 * THE REFUSAL COUNTS ARE THE POINT OF LOGGING ANY OF IT. A refutation that silently drops
 * eight of nine rows looks, from every other number, exactly like a research pass that
 * found one thing — and those two need completely different fixes (rule #11).
 */
export interface DeepLaneEvidence extends FollowUpEvidence {
  legsRead: number;
  legsUnread: number;
  legsFailed: number;
  pagesTruncated: number;
  /** Rows the synthesis proposed. */
  rowsProposed: number;
  slotsRefused: number;
  factsRefused: number;
}

export interface DeepLaneRun {
  result: DeepResult;
  evidence: DeepLaneEvidence;
  /** Kept whole so a caller can log the per-angle shape without this module deciding
   * which of it matters. Counts only — never a URL, never page text (rule #1). */
  fanOut: FanOutResult;
  /** Null when the run never reached the refutation. */
  refutation: RefutationResult | null;
}

/** The synthesis's own failures, said in the vocabulary every existing reader already
 * knows. A synthesis IS this lane's extract leg, so its failure is `extract_failed`;
 * "nothing was opened" is the grounding failure the single-leg pass calls `not_grounded`.
 * One vocabulary, so a dashboard counting deep failures counts both lanes. */
const SYNTHESIS_FAILURE: Record<
  Extract<SynthesisOutcome, { status: 'unavailable' }>['reason'],
  DeepFailure
> = {
  client_unavailable: 'client_unavailable',
  skill_unavailable: 'skill_unavailable',
  nothing_read: 'not_grounded',
  synthesis_failed: 'extract_failed',
};

function evidenceOf(
  fanOut: FanOutResult,
  rowsProposed: number,
  refutation: RefutationResult | null,
): DeepLaneEvidence {
  return {
    picks: refutation?.slots.length ?? 0,
    deepRead: fanOut.legsRead > 0 ? 1 : 0,
    deepUnread: fanOut.legsRead === 0 && fanOut.legsUnread > 0 ? 1 : 0,
    pagesRead: fanOut.pagesRead,
    pagesRefused: fanOut.pagesRefused,
    searchResults: fanOut.searchResults,
    legsRead: fanOut.legsRead,
    legsUnread: fanOut.legsUnread,
    legsFailed: fanOut.legsFailed,
    pagesTruncated: fanOut.legs.reduce((total, leg) => total + leg.pagesTruncated, 0),
    rowsProposed,
    slotsRefused: refutation?.slotsRefused ?? 0,
    factsRefused: refutation?.factsRefused ?? 0,
  };
}

/**
 * Run the whole lane for one de-identified query.
 *
 * NO RETRY, and the reason is not cost. A failed run leaves the promise OPEN, which means
 * the hourly sweep keeps it with its own single-leg pass — an hour later, with a different
 * instrument, which is a better second attempt than the same one twice.
 */
export async function runDeepLane(
  deps: DeepLaneDeps,
  query: ActivityQuery,
): Promise<DeepLaneRun> {
  const fanOut = await runFanOut(deps.researcher, query);

  if (fanOut.legsRead === 0) {
    const evidence = evidenceOf(fanOut, 0, null);
    // Every leg either failed outright or reached the web and opened nothing. Those are
    // two different sentences and the difference decides whether the promise is retried
    // as an outage or answered as a page that could not be opened.
    if (fanOut.legsUnread === 0) {
      console.error(
        { legsFailed: fanOut.legsFailed },
        'activity deep lane: every angle failed - promise left open',
      );
      return {
        result: { status: 'unavailable', reason: 'research_failed' },
        evidence,
        fanOut,
        refutation: null,
      };
    }
    console.error(
      { legsUnread: fanOut.legsUnread, pagesRefused: fanOut.pagesRefused },
      'activity deep lane: no angle opened a page - the gaps are unread, not unposted',
    );
    return {
      result: {
        status: 'unread',
        searchResults: fanOut.searchResults,
        pagesRefused: fanOut.pagesRefused,
      },
      evidence,
      fanOut,
      refutation: null,
    };
  }

  const merged = await deps.synthesiser.merge(query, fanOut);
  if (merged.status === 'unavailable') {
    return {
      result: { status: 'unavailable', reason: SYNTHESIS_FAILURE[merged.reason] },
      evidence: evidenceOf(fanOut, 0, null),
      fanOut,
      refutation: null,
    };
  }

  // THE ADVERSARIAL PASS, against exactly the page text the synthesis was handed. Not the
  // provider's original response and not a re-fetch: checking a quote against more text
  // than the merge could see would pass a fact it could not have read.
  const pages = fanOut.legs.flatMap((leg) => [...leg.pages]);
  const refutation = refuteSlots(merged.rows, pages);

  return {
    result: {
      status: 'read',
      slots: refutation.slots,
      searchResults: fanOut.searchResults,
      pagesRead: fanOut.pagesRead,
      pagesStale: fanOut.pagesStale,
      pagesRefused: fanOut.pagesRefused,
    },
    evidence: evidenceOf(fanOut, merged.rows.length, refutation),
    fanOut,
    refutation,
  };
}

/**
 * The production lane, on the ACTIVITY client.
 *
 * Both stages stream, so the client's 50-second budget bounds TIME-TO-HEADERS rather than
 * the answer — which is the only way a research leg and an `xhigh` merge fit behind one
 * client at all (deep.ts on why a non-streamed turn of this shape does not come back).
 */
export function defaultDeepLaneDeps(client: () => AgentClient = activityClient): DeepLaneDeps {
  return {
    researcher: createAngleResearcher(client),
    synthesiser: createSynthesiser(client),
  };
}
