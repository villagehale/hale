import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, laneRequestFields, pickLane } from '@hale/agent';
import { loadCronSkill } from '~/lib/cron/skill';
import type { ActivityQuery } from './deidentify';
import { type GroundingEvidence, readEvidence } from './evidence';
import { scheduleExcerpt } from './quote-match';

/**
 * THE FAN-OUT — three angles on one question, run at the same time.
 *
 * WHY THREE LEGS RATHER THAN ONE LONGER ONE. The single-leg deep pass (deep.ts) gets four
 * searches and four page opens for the WHOLE question, and the live probe shows what it
 * spends them on: it finds the venue's domain, opens the landing page, opens a schedule
 * page, and runs out. The two facts that decide whether a parent acts — the fee table and
 * the date registration opens — live on a municipal PDF and a registration portal that a
 * turn out of budget never reaches. Widening one leg does not fix it: the same probe put a
 * six-search, four-fetch turn past three hundred seconds, and its research still terminated
 * at `stop_reason: max_tokens` with the notes cut mid-page.
 *
 * So the budget is spent in PARALLEL and the wall clock is the SLOWEST leg rather than the
 * sum. Each leg holds a narrow angle, its own small search/fetch budget, and its own
 * `max_tokens`, which is what keeps each one's notes complete:
 *
 *   VENUE_SITE   — the operator's own domain: the programme page, the schedule grid.
 *   MUNICIPAL    — the town's recreation pages and the PDFs hanging off them, which is
 *                  where a fee table and a session-date grid actually live.
 *   REGISTRATION — the portal and the "how to register" page: when it opens, for whom,
 *                  and whether it is open now.
 *
 * A LEG THAT FAILS IS NOT A RUN THAT FAILS (rule #11). Every leg is settled
 * independently and reports its own outcome, so a refused fetch on the municipal page
 * does not throw away the venue's schedule. What the synthesis is then handed is an
 * HONEST partial: it is told which angles came back and which did not, and it may not
 * report the silence of a leg that never ran as the silence of a page.
 *
 * PRIVACY is the lane's, unchanged: an {@link ActivityQuery} carries a subject that has
 * cleared phase 0, a town and a stage band, and there is no field on it through which a
 * name, an age or an address could reach the border (rule #1). Nothing here logs the
 * subject.
 */

/** The angles, and the order they are reported in. A DATA vocabulary: it rides into the
 * skill payload and into the audit counts, so it is never renamed with the code. */
export const DEEP_ANGLES = ['venue_site', 'municipal', 'registration'] as const;
export type DeepAngle = (typeof DEEP_ANGLES)[number];

/**
 * One leg's search and fetch budget.
 *
 * SMALLER THAN THE SINGLE-LEG PASS ON PURPOSE. Four-and-four had to cover the whole
 * question; two-and-three covers one angle, and three angles running together buy six
 * searches and nine page opens against the old four and four — more evidence, in less
 * wall clock, with each leg's notes small enough to survive its own token budget.
 */
export const MAX_ANGLE_SEARCHES = 2;
export const MAX_ANGLE_FETCHES = 3;

/**
 * The per-leg research budget. Higher than the single-leg pass's 8192 because the leg
 * that matters most is the one that opened a fee table, and the measured single-leg runs
 * BOTH terminated at `max_tokens` — a research turn that stops mid-page writes down half
 * a schedule and nothing says so.
 */
export const ANGLE_MAX_TOKENS = 12288;

/**
 * How much of one opened page rides into the synthesis PROMPT.
 *
 * IT IS A COST BOUND, AND IT IS ONLY A COST BOUND. `readEvidence` pipes
 * `content.source.data` verbatim, and when the provider answers a `web_fetch` with a PDF
 * that data is BASE64: the live probe measured 232,118 input tokens against 249,292
 * characters of notes (≈1 token/char) versus 60,941 against 110,754 for text (≈0.55),
 * and that one PDF doubled the cost of the run on its own. Nine pages unbounded is a
 * synthesis prompt nobody sized. 24,000 characters is roughly a long municipal programme
 * page in full, and the cut is COUNTED, never silent (rule #11).
 *
 * IT DOES NOT BOUND THE CHECK, and the sentence that used to stand here — "a fact past the
 * cut is a fact that is never claimed rather than one that is claimed and then refused" —
 * was false in production. The leg model reads the page IN ITS OWN CONTEXT, whole, and
 * writes what it found into its prose; the merge can therefore report a fact from past the
 * cut perfectly honestly. On 2026-08-24 it did: the Parent-and-Tot grid began at character
 * 27,153 of a 63,846-character page, the merge returned twenty-seven true rows off it, and
 * the refutation — checking against the 24,000-character snapshot — refused all fifty-three
 * facts as absent. So {@link AngleLeg.pages} carries the WHOLE page and only `notes` is
 * bounded: tokens are what cost money, and the checker spends none.
 */
export const MAX_PAGE_NOTE_CHARS = 24_000;

/** What one angle came back with. */
export interface AngleLeg {
  angle: DeepAngle;
  /** `read` — at least one page opened. `unread` — it searched and every fetch was
   * refused. `failed` — the leg never completed at all. Three outcomes because they
   * license three different sentences, and folding them rebuilds the benchmark defect. */
  status: 'read' | 'unread' | 'failed';
  searchResults: number;
  pagesRead: number;
  pagesStale: number;
  pagesRefused: number;
  /** The pages this leg opened, WHOLE. The refutation's evidence and the absence
   * licence's, neither of which spends a token on them. */
  pages: ReadonlyArray<{ url: string; text: string }>;
  /** Everything the leg wrote down — its prose and its opened pages — with each page cut
   * at {@link MAX_PAGE_NOTE_CHARS}. This is the string the synthesis is prompted with, and
   * the only place the bound applies. Empty on a `failed` leg. */
  notes: string;
  /** How many pages were cut on their way into `notes`. Counted so a synthesis that was
   * shown half a fee table is legible as such. */
  pagesTruncated: number;
  /** Why a `failed` leg failed. A message, never a payload: a provider error can echo the
   * request back (rule #1), so only the class and message are kept. */
  reason: string | null;
}

export interface FanOutResult {
  legs: readonly AngleLeg[];
  /** Legs that opened at least one page. Zero means nothing licenses a claim about what
   * any page carries. */
  legsRead: number;
  /** Legs that reached the web and opened nothing. */
  legsUnread: number;
  /** Legs that never completed. */
  legsFailed: number;
  searchResults: number;
  pagesRead: number;
  pagesStale: number;
  pagesRefused: number;
}

export interface AngleResearcher {
  research(query: ActivityQuery, angle: DeepAngle): Promise<AngleLeg>;
}

/** The research payload for ONE angle — the de-identified query plus which angle this
 * leg is holding. Shared with the eval, which replicates this shape. */
export function angleUserMessage(query: ActivityQuery, angle: DeepAngle): string {
  return JSON.stringify({
    mode: 'deep_research',
    angle,
    subject: query.subject,
    ...(query.town ? { town: query.town } : {}),
    ...(query.stage ? { stage: query.stage } : {}),
    ...(query.window ? { window: query.window } : {}),
  });
}

/**
 * The lane's model and reasoning knobs, narrowed to the one field the pinned SDK (0.41.0)
 * types — the same blocker and the same tactic as `wireLane` in deep.ts.
 */
function wireLane(task: Parameters<typeof pickLane>[0]): Pick<Anthropic.MessageCreateParams, 'model'> {
  return laneRequestFields(pickLane(task)) as Pick<Anthropic.MessageCreateParams, 'model'>;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function failedLeg(angle: DeepAngle, detail: string): AngleLeg {
  // Never the subject or the notes — a provider error can echo the request back (rule #1).
  console.error({ angle, detail }, 'activity fan-out: leg failed');
  return {
    angle,
    status: 'failed',
    searchResults: 0,
    pagesRead: 0,
    pagesStale: 0,
    pagesRefused: 0,
    pages: [],
    notes: '',
    pagesTruncated: 0,
    reason: detail,
  };
}

/**
 * Build the leg's two views of what it read: the WHOLE pages, and the bounded string the
 * merge is prompted with.
 *
 * They are deliberately not the same value. The bound is a bill, not a fact about the
 * world (see {@link MAX_PAGE_NOTE_CHARS}), and letting it reach the checker is what turned
 * a published grid into "not posted yet".
 */
export function boundEvidence(evidence: GroundingEvidence): {
  pages: ReadonlyArray<{ url: string; text: string }>;
  notes: string;
  pagesTruncated: number;
} {
  let pagesTruncated = 0;
  const shown = evidence.pages.map((page) => {
    // NOT THE FIRST 24,000 CHARACTERS - the 24,000 that carry the schedule. A head slice
    // of a municipal page buys the parking information and drops the grid, which is the
    // other half of the 2026-08-24 failure (quote-match.ts `scheduleExcerpt`).
    const excerpt = scheduleExcerpt(page.text, MAX_PAGE_NOTE_CHARS);
    if (!excerpt.truncated) return page;
    pagesTruncated += 1;
    return { url: page.url, text: excerpt.text };
  });
  // JOINED FROM PARTS, never cut back out of the joined string: `prose` and `pages` are
  // separate fields on the evidence for exactly this reason (evidence.ts).
  const body = shown.map((page) => `--- page: ${page.url} ---\n${page.text}`);
  return {
    pages: evidence.pages,
    notes: [evidence.prose, ...body].join('\n').trim(),
    pagesTruncated,
  };
}

/**
 * One angle's research turn.
 *
 * STREAMED, because a non-streamed turn of this shape does not come back: live probe
 * 2026-08-22, `messages.create` on the single-leg request timed out at 50s and died at
 * 120s against a 600s ceiling, while the same request streamed returned in 88.8s
 * (deep.ts). The client timeout bounds TIME-TO-HEADERS, which a stream reaches in a
 * second.
 *
 * `tool_choice` cannot force a server tool, so "it actually looked" is a code invariant —
 * `searchResults === 0` is an `unread` leg, never a leg that reports pages.
 */
export function createAngleResearcher(
  client: () => AgentClient,
  now: () => Date = () => new Date(),
): AngleResearcher {
  return {
    async research(query, angle) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return failedLeg(angle, `client_unavailable: ${reason(err)}`);
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('activity-deep');
      } catch (err) {
        return failedLeg(angle, `skill_unavailable: ${reason(err)}`);
      }

      let research: Anthropic.Message;
      try {
        research = await resolved.messages
          .stream({
            ...wireLane(skill.meta.task),
            max_tokens: ANGLE_MAX_TOKENS,
            system: skill.instructions,
            // Cast because the pinned SDK (0.41.0) predates `web_fetch` and has no member
            // for it in `ToolUnion`. The wire shape is live-probed (see deep.ts); the SDK
            // serialises the tool list as given.
            tools: [
              { name: 'web_search', type: 'web_search_20250305', max_uses: MAX_ANGLE_SEARCHES },
              {
                name: 'web_fetch',
                type: 'web_fetch_20260209',
                max_uses: MAX_ANGLE_FETCHES,
              } as unknown as Anthropic.ToolUnion,
            ],
            messages: [{ role: 'user', content: angleUserMessage(query, angle) }],
          })
          .finalMessage();
      } catch (err) {
        return failedLeg(angle, `research_failed: ${reason(err)}`);
      }

      const evidence = readEvidence(now(), research.content);
      if (evidence.searchResults === 0) {
        return failedLeg(angle, 'not_grounded: the leg issued no search');
      }
      const bounded = boundEvidence(evidence);
      return {
        angle,
        status: evidence.pagesRead > 0 ? 'read' : 'unread',
        searchResults: evidence.searchResults,
        pagesRead: evidence.pagesRead,
        pagesStale: evidence.pagesStale,
        pagesRefused: evidence.pagesRefused,
        pages: bounded.pages,
        notes: bounded.notes,
        pagesTruncated: bounded.pagesTruncated,
        reason: null,
      };
    },
  };
}

/**
 * Run every angle AT ONCE and settle each on its own.
 *
 * `allSettled` and not `all`, because `all` would make the whole run as fragile as its
 * unluckiest leg — a single refused municipal page would throw away a venue schedule
 * that was already in hand. A leg that rejects is turned into a `failed` leg, which is a
 * reported outcome rather than an exception (rule #11).
 */
export async function runFanOut(
  researcher: AngleResearcher,
  query: ActivityQuery,
  angles: readonly DeepAngle[] = DEEP_ANGLES,
): Promise<FanOutResult> {
  const settled = await Promise.allSettled(
    angles.map((angle) => researcher.research(query, angle)),
  );
  const legs = settled.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : failedLeg(angles[index] as DeepAngle, `threw: ${reason(outcome.reason)}`),
  );
  return {
    legs,
    legsRead: legs.filter((leg) => leg.status === 'read').length,
    legsUnread: legs.filter((leg) => leg.status === 'unread').length,
    legsFailed: legs.filter((leg) => leg.status === 'failed').length,
    searchResults: legs.reduce((total, leg) => total + leg.searchResults, 0),
    pagesRead: legs.reduce((total, leg) => total + leg.pagesRead, 0),
    pagesStale: legs.reduce((total, leg) => total + leg.pagesStale, 0),
    pagesRefused: legs.reduce((total, leg) => total + leg.pagesRefused, 0),
  };
}
