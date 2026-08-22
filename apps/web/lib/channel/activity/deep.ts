import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, laneRequestFields, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { ActivityQuery } from './deidentify';
import { readEvidence } from './evidence';
import type { ActivityPick } from './lane';

/**
 * THE DEEP PASS — what the follow-up sweep does instead of re-running the same shallow
 * search a day later.
 *
 * THE PROMISE THIS KEEPS. The inline lane has thirty seconds and a parent watching three
 * dots, so it reads what a search engine chose to show it. The sweep has neither, and
 * until now it spent that freedom on nothing: it ran the identical snippet search and
 * came back with the identical answer. This is the leg that uses it — site-scoped
 * searches into the operator's own domain, then `web_fetch` on the pages those searches
 * surfaced, then an extraction that must cite the page every fact came off.
 *
 * TWO MODEL LEGS, AND NO MORE (the sweep's budget, stated where it is spent):
 *
 *   1. RESEARCH — one turn holding `web_search` (×{@link MAX_DEEP_SEARCHES}) and
 *      `web_fetch` (×{@link MAX_DEEP_FETCHES}). It searches, opens pages, and writes down
 *      what they said.
 *   2. EXTRACT — `forceToolJson` against the blind `activity-deep` skill: the
 *      de-identified query plus the research notes, never the parent's message. Out come
 *      structured slots, each carrying its `source_url`.
 *
 * The TEXT is not a third leg. The slots go to the follow-up composer that already exists
 * (followup-note.ts) with its own gates and its own recompose loop — this module's job is
 * to hand that composer something worth writing about, not to become a second author.
 *
 * WHY THE FETCH BUDGET IS WHAT IT IS. Live probe, `claude-sonnet-5`, 2026-08-21:
 * `web_fetch_20260209` needs no beta header and does open real pages, but it is not a
 * reliable instrument — `cartwheelsgymcentre.com/programs.php` came back `url_not_allowed`
 * while the same site's root opened fine, a Halton Hills municipal page came back
 * `url_not_accessible`, and a turn given six searches and four fetches ran past three
 * hundred seconds. So: FOUR searches and FOUR fetches. Four fetches is the venue landing
 * page plus the three that actually carry the answer (schedule, registration, fees), it is
 * what the two benchmark defects each needed, and it keeps one research turn inside the
 * cron slot the whole nudge route shares (maxDuration 300).
 *
 * WHAT MAKES THIS DIFFERENT FROM A LONGER SEARCH: {@link DeepResult} distinguishes a turn
 * that READ pages and found nothing from one that opened none. Those are two different
 * true sentences and the benchmark defect was Hale saying the first while meaning the
 * second (rule #11 — the absence of the effect is a first-class outcome).
 *
 * PRIVACY is the lane's, unchanged: this module takes an {@link ActivityQuery} — a
 * subject that has already cleared phase 0, a town, a stage band — and there is no field
 * on it through which a name, an age or an address could reach the border (rule #1).
 * Nothing here logs the subject.
 */

/** Site-scoped searches per research turn: find the domain, then its schedule, its
 * registration page and its fees. A fifth has never surfaced a page the first four
 * missed in the corpus. */
export const MAX_DEEP_SEARCHES = 4;

/** Pages opened per research turn — see the module note for the probe this number came
 * from. The landing page plus the three that carry the day, the money and the deadline. */
export const MAX_DEEP_FETCHES = 4;

/**
 * Exported so the test can assert the research leg's budget against the constant rather
 * than a copy of the number.
 */
export const RESEARCH_MAX_TOKENS = 8192;
/** Generous: a venue with eight class times is eight rows, and `forceToolJson` throws on
 * a max_tokens cut rather than handing back half a schedule. */
const EXTRACT_MAX_TOKENS = 4096;

/**
 * One concrete thing a parent could book, read off a page somebody opened.
 *
 * It is an {@link ActivityPick} plus the two fields that make the deep pass worth its
 * cost: `registration` — the fact that decides whether a parent acts today, and the one
 * that was sitting in plain sight on both benchmark pages — and `sourceUrl`, the page the
 * row was read off. A row with no `sourceUrl` is dropped: an uncited fact from a leg
 * whose entire justification is that it opened pages is a fact nobody read.
 */
export interface DeepSlot extends ActivityPick {
  /** When registration opens, closes, or that it is open now. Null when no page said. */
  registration: string | null;
  /** The page this row was read off — not the home page, not a search result. */
  sourceUrl: string;
}

export type DeepFailure =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'not_grounded'
  | 'research_failed'
  | 'extract_failed';

/**
 * What the deep pass came back with.
 *
 * `read` and `unread` are the whole point and are never folded together. `read` means at
 * least one page was opened, so an empty `slots` is a true "there is nothing running" the
 * follow-up may say out loud. `unread` means every fetch was refused or unreachable — the
 * turn knows nothing about what those pages carry, and a follow-up written from it must
 * not claim they carry nothing.
 */
export type DeepResult =
  | {
      status: 'read';
      slots: DeepSlot[];
      searchResults: number;
      pagesRead: number;
      /** How many of `pagesRead` came out of the provider's cache from before today
       * (evidence.ts `FETCH_FRESHNESS_MS`). A stale read licenses no claim about what a
       * page carries NOW, which is the only claim the follow-up ever wants to make. */
      pagesStale: number;
      pagesRefused: number;
    }
  | { status: 'unread'; searchResults: number; pagesRefused: number }
  | { status: 'unavailable'; reason: DeepFailure };

export interface DeepResearcher {
  research(query: ActivityQuery): Promise<DeepResult>;
}

const slotSchema = z.object({
  name: z.string().nullish(),
  age_fit: z.string().nullish(),
  when: z.string().nullish(),
  price: z.string().nullish(),
  registration: z.string().nullish(),
  source_name: z.string().nullish(),
  source_url: z.string().nullish(),
});

/** Loose, not `.strict()` — zod puts unrecognised KEY NAMES into `ZodError.message`, which
 * the catch below logs, so a strict schema turns a stray field into a log line that can
 * carry text back (the medical lane's rule, and the inline lane's). */
const extractSchema = z.object({
  pages_read: z.array(z.string()).nullish(),
  slots: z.array(slotSchema),
});

const extractJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    pages_read: { type: 'array', items: { type: 'string' } },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age_fit: { type: 'string' },
          when: { type: 'string' },
          price: { type: 'string' },
          registration: { type: 'string' },
          source_name: { type: 'string' },
          source_url: { type: 'string' },
        },
        // `when`, `price` and `registration` are omitted for the reason ActivityPick
        // states: a required field a page never published is one the model can only
        // satisfy by inventing or by dropping the whole find, and it chooses dropping.
        required: ['name', 'age_fit', 'source_name', 'source_url'],
      },
    },
  },
  required: ['slots'],
};

/** The research payload — the de-identified query and nothing that could identify a
 * child. Shared with the eval, which replicates this shape. */
export function deepUserMessage(query: ActivityQuery): string {
  return JSON.stringify({
    mode: 'deep_research',
    subject: query.subject,
    ...(query.town ? { town: query.town } : {}),
    ...(query.stage ? { stage: query.stage } : {}),
    ...(query.window ? { window: query.window } : {}),
  });
}

/** The extract payload: the same query plus what the pages said. Blind to the parent. */
export function deepExtractMessage(query: ActivityQuery, notes: string): string {
  return JSON.stringify({ ...JSON.parse(deepUserMessage(query)), research_notes: notes });
}

function field(value: unknown): string {
  return typeof value === 'string' ? plainText(value) : '';
}

/** Only an absolute http(s) URL counts as a citation — the same fail-closed rule the
 * public share surface applies to a sourceUrl (village/public.ts). */
function citation(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(raw)) return null;
  return raw;
}

/**
 * The whole-row rule. What identifies a slot — its name, who it is for, whose page, and
 * WHICH page — is required; what a page may simply not have published is nullable.
 */
export function toDeepSlots(raw: z.infer<typeof extractSchema>['slots']): DeepSlot[] {
  const slots: DeepSlot[] = [];
  for (const item of raw) {
    const name = field(item.name);
    const ageFit = field(item.age_fit);
    const sourceName = field(item.source_name);
    const sourceUrl = citation(item.source_url);
    if (name === '' || ageFit === '' || sourceName === '' || sourceUrl === null) continue;
    const when = field(item.when);
    const price = field(item.price);
    const registration = field(item.registration);
    slots.push({
      name,
      ageFit,
      when: when === '' ? null : when,
      price: price === '' ? null : price,
      registration: registration === '' ? null : registration,
      sourceName,
      sourceUrl,
      // Stamped by CODE. There is no argument through which the model could claim this
      // was verified by us — the same two-tier sourcing the inline lane holds.
      source: 'web',
    });
  }
  return slots;
}

/**
 * The lane's model and reasoning knobs, narrowed to the one field the pinned SDK (0.41.0)
 * types. `thinking: {type:'adaptive'}` and `output_config` are plain top-level body
 * fields needing no beta header, and the SDK serialises the body as given — the same
 * blocker and the same tactic as `wireLane` in packages/agent/src/agent.ts, and narrowing
 * rather than casting the whole request keeps max_tokens, system, tools and messages
 * type-checked.
 */
function wireLane(task: Parameters<typeof pickLane>[0]): Pick<Anthropic.MessageCreateParams, 'model'> {
  return laneRequestFields(pickLane(task)) as Pick<Anthropic.MessageCreateParams, 'model'>;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function unavailable(failure: DeepFailure, detail: string): DeepResult {
  // Never the subject or the notes — a provider error can echo the request back (rule #1).
  console.error({ reason: failure, detail }, 'activity deep pass: could not research');
  return { status: 'unavailable', reason: failure };
}

/**
 * The production deep researcher.
 *
 * `client` is a RESOLVER for the reason every model stage on this path takes one: the
 * sweep builds its dependencies for every tick, including the ones that send nothing, so
 * a missing key must be an honest `client_unavailable` rather than a throw at wiring time.
 *
 * NO RETRY, unlike the inline lane. A research turn here costs a minute of a shared
 * three-hundred-second cron slot; a second one would spend another family's turn to say
 * the same thing twice. A failure leaves the promise open and the next tick tries again,
 * which is the retry — an hour later, for free.
 */
export function createDeepResearcher(
  client: () => AgentClient,
  /** Read once per turn, and only to age the provider's `retrieved_at` stamps — the same
   * default-clock shape `runActivityFollowUpSweep` takes. */
  now: () => Date = () => new Date(),
): DeepResearcher {
  return {
    async research(query) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unavailable('client_unavailable', reason(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('activity-deep');
      } catch (err) {
        return unavailable('skill_unavailable', reason(err));
      }

      // Leg 1 — RESEARCH, STREAMED. `tool_choice` cannot force a server tool, so "it
      // actually looked" is a code invariant checked below and not a hope in a prompt.
      //
      // THE STREAM IS NOT AN OPTIMISATION — it is the only transport this turn survives.
      // Live probe against the real API, 2026-08-22, production wiring: `messages.create`
      // on this exact request came back `Request timed out.` at 50,005 ms and 50,021 ms,
      // and given a 600-second ceiling it died at 120,014 ms with a connection error. A
      // non-streamed turn holding four searches and four page opens does not finish,
      // whatever the client timeout says. Streamed, the same request returned in
      // 88,795 ms with 9 search results and 3 pages read. Until this line every
      // production deep pass was `research_failed`, the sweep fell back to the shallow
      // snippet finder, and the "I opened their page" leg never once ran.
      //
      // The 50s client timeout stays as it is: it bounds TIME-TO-HEADERS, which a stream
      // reaches in a second (see ACTIVITY_CLIENT_OPTIONS' own note on the SDK clearing
      // its abort timer once the response arrives).
      let research: Anthropic.Message;
      try {
        research = await resolved.messages
          .stream({
            // The lane's knobs, stated rather than inherited: an omitted `thinking` means
            // ADAPTIVE on Sonnet 5, so this turn was running an unbudgeted reasoning
            // setting that no lane review had ever seen (packages/agent model.ts).
            ...wireLane(skill.meta.task),
            max_tokens: RESEARCH_MAX_TOKENS,
            system: skill.instructions,
            // Cast because the pinned SDK (0.41.0) predates `web_fetch` and has no member
            // for it in `ToolUnion`. The wire shape is live-probed (see the module note);
            // the SDK serialises the tool list as given.
            tools: [
              { name: 'web_search', type: 'web_search_20250305', max_uses: MAX_DEEP_SEARCHES },
              {
                name: 'web_fetch',
                type: 'web_fetch_20260209',
                max_uses: MAX_DEEP_FETCHES,
              } as unknown as Anthropic.ToolUnion,
            ],
            messages: [{ role: 'user', content: deepUserMessage(query) }],
          })
          .finalMessage();
      } catch (err) {
        return unavailable('research_failed', reason(err));
      }

      const evidence = readEvidence(now(), research.content);
      if (evidence.searchResults === 0 || evidence.notes === '') {
        // It did not look, or it looked and wrote nothing down. Either way the extract
        // leg would be standing on air, which is the fabrication this lane exists to
        // refuse — and it is an outage, not news, so nothing is said and nothing closes.
        return unavailable('not_grounded', `searches=${evidence.searchResults}`);
      }

      // Leg 2 — EXTRACT (blind: the de-identified query and the notes, never the message).
      let extracted: z.infer<typeof extractSchema>;
      try {
        ({ value: extracted } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: deepExtractMessage(query, evidence.notes),
          toolName: 'activity_deep',
          toolDescription: 'Return the concrete slots the pages actually printed.',
          inputJsonSchema: extractJsonSchema,
          schema: extractSchema,
          maxTokens: EXTRACT_MAX_TOKENS,
        }));
      } catch (err) {
        return unavailable('extract_failed', reason(err));
      }

      const slots = toDeepSlots(extracted.slots);
      if (evidence.pagesRead === 0) {
        // THE BENCHMARK DEFECT, refused in code. Every fetch was turned away, so this turn
        // knows nothing about what those pages carry. Slots scraped out of snippets are
        // still real finds and the sweep may still send them — what it may NOT do is
        // present the absence of dates as something a page said (rule #11).
        console.error(
          { pagesRefused: evidence.pagesRefused, slots: slots.length },
          'activity deep pass: no page opened - the gaps are unread, not unposted',
        );
        return {
          status: 'unread',
          searchResults: evidence.searchResults,
          pagesRefused: evidence.pagesRefused,
        };
      }
      return {
        status: 'read',
        slots,
        searchResults: evidence.searchResults,
        pagesRead: evidence.pagesRead,
        pagesStale: evidence.pagesStale,
        pagesRefused: evidence.pagesRefused,
      };
    },
  };
}
