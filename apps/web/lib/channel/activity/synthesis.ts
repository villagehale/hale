import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { ActivityQuery } from './deidentify';
import type { AngleLeg, FanOutResult } from './fanout';

/**
 * THE SYNTHESIS — three angles' worth of pages, merged into rows a parent can act on.
 *
 * WHY IT IS A SEPARATE LEG AND A DEARER ONE. Each research leg comes back with the raw
 * text of the pages it opened and no view of the other two. The fee is on the municipal
 * PDF, the weekday and the clock time are in the venue's grid, and the date registration
 * opens is on the portal — one programme, three pages, and no leg saw more than one of
 * them. Deciding that those three facts describe the SAME slot, and that a fourth fact on
 * a fourth page is a different age band and belongs to nobody, is the judgment this lane
 * is for. It runs at most once per promise, so it is the cheap kind of expensive.
 *
 * EVERY FACT CARRIES ITS QUOTE AND ITS OWN PAGE, and that is the whole contract with the
 * refutation. `when`, `price` and `registration` each come back beside a VERBATIM span and
 * the URL that span was copied from. The synthesis is not trusted about any of it:
 * refute.ts looks each quote up in exactly the page text this run was given, and a fact
 * whose quote is not on the page it names is dropped before anybody reads it (rule #1's
 * fail-closed discipline, the medical lane's shape).
 *
 * THE CITATION BELONGS TO THE FACT, NOT TO THE ROW, and the first version of this got it
 * wrong. Pinning every quote to one `source_url` made the merge unable to do the one thing
 * it exists for: the fee is on the venue's table and the registration date is on the town's
 * portal, so a row cited to either page had the other fact refused as a fabrication. The
 * journey test caught it — the second message went out with the registration date silently
 * missing, which is the 2026-08-21 defect wearing a gate. A per-fact source keeps the
 * invariant exact ("this fact is on THIS page, which somebody opened") while letting one
 * slot span three pages.
 *
 * That is not paperwork. The 2026-08-21 defect was Hale reporting a schedule as unposted
 * while it sat on the venue's own page; the mirror-image defect — a price lifted off the
 * ROOM RENTAL table on the same site and attributed to a toddler class — is the one a
 * merge across three pages makes newly easy, and a quote is the only thing that catches it.
 *
 * BLIND, like every other leg on this path: the de-identified query and page text, never
 * the parent's message, never a child (rule #1).
 */

/**
 * The synthesis budget.
 *
 * `max_tokens` caps THINKING and output together on a reasoning lane, and this one runs
 * at `xhigh` over as many as nine pages. A municipal fall grid is thirty-odd dated rows,
 * each now carrying a quote as well, so the output alone can be several thousand tokens
 * before the reasoning is counted. Nobody is waiting on this turn — the parent has
 * already had their inline answer — so the budget is bought with money rather than
 * latency, and `forceToolJson` still throws on a cut rather than handing back half a
 * schedule.
 */
export const SYNTHESIS_MAX_TOKENS = 32768;

/** One merged row, as the model returns it — every schedule fact beside the span it was
 * read off. */
const rowSchema = z.object({
  name: z.string().nullish(),
  age_fit: z.string().nullish(),
  when: z.string().nullish(),
  when_quote: z.string().nullish(),
  when_source: z.string().nullish(),
  price: z.string().nullish(),
  price_quote: z.string().nullish(),
  price_source: z.string().nullish(),
  registration: z.string().nullish(),
  registration_quote: z.string().nullish(),
  registration_source: z.string().nullish(),
  source_name: z.string().nullish(),
  source_url: z.string().nullish(),
});

export type SynthesisRow = z.infer<typeof rowSchema>;

/** AN ARRAY THE MODEL SENT AS A STRING IS STILL AN ARRAY — collapsed at the parse
 * boundary, the same shape and the same live-probed reason as deep.ts. */
function arrayFromMaybeString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/** Loose, not `.strict()` — zod puts unrecognised KEY NAMES into `ZodError.message`,
 * which the catch logs, so a strict schema turns a stray field into a log line that can
 * carry page text back (the medical lane's rule, and the inline lane's). */
const synthesisSchema = z.object({
  slots: z.preprocess(arrayFromMaybeString, z.array(rowSchema)),
});

const synthesisJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age_fit: { type: 'string' },
          when: { type: 'string' },
          when_quote: { type: 'string' },
          when_source: { type: 'string' },
          price: { type: 'string' },
          price_quote: { type: 'string' },
          price_source: { type: 'string' },
          registration: { type: 'string' },
          registration_quote: { type: 'string' },
          registration_source: { type: 'string' },
          source_name: { type: 'string' },
          source_url: { type: 'string' },
        },
        // The schedule facts and their quotes are omitted for the reason ActivityPick
        // states: a required field a page never published is one the model can only
        // satisfy by inventing or by dropping the whole find, and it chooses dropping.
        required: ['name', 'age_fit', 'source_name', 'source_url'],
      },
    },
  },
  required: ['slots'],
};

export type SynthesisOutcome =
  | { status: 'synthesised'; rows: readonly SynthesisRow[] }
  | { status: 'unavailable'; reason: SynthesisFailure };

export type SynthesisFailure =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'nothing_read'
  | 'synthesis_failed';

export interface Synthesiser {
  merge(query: ActivityQuery, fanOut: FanOutResult): Promise<SynthesisOutcome>;
}

/** One leg, as the synthesis is told about it. A leg that never ran is REPORTED rather
 * than omitted: silence from an angle that failed is not silence from a page, and a
 * merge that cannot tell them apart will write the second sentence (rule #11). */
function legPayload(leg: AngleLeg) {
  return {
    angle: leg.angle,
    status: leg.status,
    pages_read: leg.pagesRead,
    pages_refused: leg.pagesRefused,
    pages_truncated: leg.pagesTruncated,
    notes: leg.notes,
  };
}

/** The synthesis payload. Shared with the eval, which replicates this shape. */
export function synthesisUserMessage(query: ActivityQuery, fanOut: FanOutResult): string {
  return JSON.stringify({
    mode: 'deep_synthesis',
    subject: query.subject,
    ...(query.town ? { town: query.town } : {}),
    ...(query.stage ? { stage: query.stage } : {}),
    ...(query.window ? { window: query.window } : {}),
    legs: fanOut.legs.map(legPayload),
  });
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function unavailable(failure: SynthesisFailure, detail: string): SynthesisOutcome {
  // Never the subject or the notes — a provider error can echo the request back (rule #1).
  console.error({ reason: failure, detail }, 'activity synthesis: could not merge the legs');
  return { status: 'unavailable', reason: failure };
}

/**
 * The production synthesiser.
 *
 * `client` is a RESOLVER for the reason every model stage on this path takes one: the
 * deep job builds its dependencies before it knows whether it will use them, so a missing
 * key must be an honest `client_unavailable` rather than a throw at wiring time.
 */
export function createSynthesiser(client: () => AgentClient): Synthesiser {
  return {
    async merge(query, fanOut) {
      if (fanOut.legsRead === 0) {
        // Nothing was opened by any angle. There is no page to quote and therefore
        // nothing this lane may say about what pages carry — the benchmark defect,
        // refused before a token is spent.
        return unavailable('nothing_read', `legs=${fanOut.legs.length}`);
      }

      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unavailable('client_unavailable', reason(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('activity-synthesis');
      } catch (err) {
        return unavailable('skill_unavailable', reason(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: synthesisUserMessage(query, fanOut),
          toolName: 'activity_synthesis',
          toolDescription: 'Return the merged slots, each fact beside the span it was read off.',
          inputJsonSchema: synthesisJsonSchema,
          schema: synthesisSchema,
          maxTokens: SYNTHESIS_MAX_TOKENS,
          // The one caller that needs it: an `xhigh` lane over as many as nine pages
          // generates for minutes before a non-streamed request would produce a header.
          transport: 'stream',
        });
        return { status: 'synthesised', rows: value.slots };
      } catch (err) {
        return unavailable('synthesis_failed', reason(err));
      }
    },
  };
}
