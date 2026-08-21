import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { ActivityQuery } from './deidentify';

/**
 * THE WEB-GROUNDED ACTIVITY LANE — what a parent gets when they ask what their child can
 * do, and the radar has nothing.
 *
 * WHAT IT REPLACES. On 2026-08-20 a parent asked what there was for their toddler from
 * September to December. The only tool Hale had was `search_village`, a read over finds
 * the radar had already discovered — and every one of them was filtered out (a season
 * gate that hides fall programs from a question asked in summer, a substring match over
 * the whole query, and an offerability rule no row in production satisfies). So Hale said
 * it would come back to them. Three minutes later they asked about a specific gym by name
 * and Hale called no tool at all, then offered "want me to do a search?" — a verb that did
 * not exist. The same question in ChatGPT returned the same venues the radar had been
 * sitting on. What was missing was not data. It was a way to LOOK.
 *
 * THREE PHASES, the medical lane's shape (off-domain/medical.ts) fitted to a question
 * whose failure mode is different:
 *
 *   0. DE-IDENTIFY — deterministic, no model, in {@link deidentifyActivityQuery}. See
 *      that file for why this lane can hold a stronger line than the medical one: Hale
 *      knows the household's names, so a subject containing one is REFUSED rather than
 *      trusted to a sanitizer. Only a scrubbed subject, a coarse window, a town and a
 *      stage word cross the border.
 *
 *   1. GROUND — a `web_search` server-tool turn on the de-identified query. `tool_choice`
 *      cannot FORCE a server tool, so "always grounded" is a code invariant and not a
 *      prompt hope: zero `web_search_tool_result` items is a failure. THIS IS THE
 *      INVARIANT THE LANE EXISTS FOR. A medical answer that did not search is unsafe; an
 *      activity answer that did not search is a VENUE THAT DOES NOT EXIST — a parent
 *      putting a toddler in the car and driving to an address a model wrote down. There
 *      is no version of this lane that is allowed to answer from memory.
 *
 *   2. COMPOSE — `forceToolJson` against the BLIND `activity-finder` skill (it sees the
 *      de-identified query and the research notes; never the parent's message, never a
 *      name) → `{ picks[] }`. Structured fields, not prose: the coach writes the sentence
 *      a parent reads, and this stage's job is to turn a page of search results into
 *      facts that can be checked.
 *
 * NEVER A DIRECTORY. At most {@link MAX_PICKS} come back, and each one is WHOLE — a name,
 * an age fit, a when, and where the fact came from. A pick missing any of those is dropped
 * rather than shipped with the doubt attached, which is `search_village`'s own offerability
 * rule applied to the web: a parent who wanted to chase a maybe would not have texted.
 *
 * HONEST SOURCING, HELD IN CODE. Every pick this lane returns carries `source: 'web'`,
 * stamped HERE and not by the model, next to the `sourceName` the fact was read off. That
 * is what makes "their site says X" checkable rather than a request in a prompt: the
 * radar's own finds come back from a different tool with a different provenance, and a
 * web pick has no field in which it could claim to have been verified by us. What the lane
 * must never do is the other failure — go quiet because a fact is unverified. "I want to
 * make sure the details hold up" is not a reason to say nothing; it is a reason to say
 * whose details they are.
 *
 * FAIL CLOSED, THROUGH ONE DOOR. Every degradation is a thrown {@link ActivityUnresolvable}
 * with a NAMED reason (rule #11), the turn is retried ONCE, and a second failure comes back
 * as a `{ found: false, reason }` the coach can be honest about — never silence, and never
 * a fabricated find.
 *
 * PRIVACY. Nothing in this module logs the subject or the window: they are the fields that
 * came off a parent's sentence, and a provider error can echo a request back, so only the
 * class and the message string survive (rule #1).
 */

/**
 * The most picks one answer may carry. THREE, and the number is the doctrine rather than
 * a layout constraint: Hale answers with a choice a person can hold in their head while
 * driving, not a list they have to work through. A fourth pick is the moment this stops
 * being a chief of staff and starts being a search results page.
 */
export const MAX_PICKS = 3;

/**
 * The web-search budget for ONE call of this lane, and with {@link MAX_ACTIVITY_CALLS_PER_TURN}
 * the hard per-turn spend bound (rule #7's discipline applied to a cost the reviewer
 * cannot see, because it is billed by the provider rather than spent on a family's behalf).
 * Three searches is enough to check a program, its schedule and its registration page; a
 * fourth has never changed an answer in the corpus.
 */
export const MAX_SEARCHES = 3;

/**
 * How many times ONE texted turn may reach the web. Two: a parent legitimately asks a
 * general question and then names a place ("what about Cartwheel Gym?"), which is the
 * 2026-08-20 transcript exactly. A third is a model looping, and the cap refuses it with a
 * sentence rather than spending the budget.
 *
 * The whole-turn ceiling is therefore {@link MAX_ACTIVITY_CALLS_PER_TURN} ×
 * {@link MAX_SEARCHES} searches, plus one retry each — bounded, and bounded in a place a
 * reader can find it.
 */
export const MAX_ACTIVITY_CALLS_PER_TURN = 2;

const GROUND_MAX_TOKENS = 4096;
/** Generous on purpose: `forceToolJson` throws on a max_tokens cutoff, and a pick cut in
 * half is a venue name a parent cannot search for. */
const COMPOSE_MAX_TOKENS = 1024;

/** Where a fact came from. Stamped by CODE, never by a model — see the module note. */
export type ActivitySource = 'web';

/**
 * One thing a parent could actually turn up to. Every field but `price` is non-null by
 * construction, because an offer a parent cannot act on is not an offer: a find with no
 * `when` is the "I found a class but couldn't confirm the time" the skill already
 * forbids. `price` is nullable and NOT a reason to drop a pick — plenty of real programs
 * do not publish one, and withholding a good find over a missing dollar figure is the
 * same silence this lane exists to end.
 */
export interface ActivityPick {
  name: string;
  /** Who it is for, in the source's own words: "18 months - 3 years", "ages 2-4". */
  ageFit: string;
  /** When it runs, in the source's own words: "Saturdays 9:15am, fall session from Sept 13". */
  when: string;
  /** What it costs, in the source's own words, or null when the source did not say. */
  price: string | null;
  /** WHOSE page this came off — the organisation, not a URL. Hale never texts a link
   * (coach-channel-sms.md), so a link here would be an invitation to break that. */
  sourceName: string;
  source: ActivitySource;
}

/**
 * Why an activity search produced nothing. `no_picks` is the honest empty result and the
 * only one that is not a fault: the search ran, the page was read, and there is nothing
 * running. It is deliberately NOT folded in with the failures, because what Hale says to a
 * parent differs — "there's nothing on" is an answer, and "I couldn't look just now" is not
 * (rule #11).
 */
export type ActivityFailure =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'ground_failed'
  | 'not_grounded'
  | 'compose_failed'
  | 'no_picks';

export type ActivityFindResult =
  | { found: true; picks: ActivityPick[] }
  | { found: false; reason: ActivityFailure };

export interface ActivityFinder {
  find(query: ActivityQuery): Promise<ActivityFindResult>;
}

class ActivityUnresolvable extends Error {
  constructor(
    readonly reason: ActivityFailure,
    readonly detail?: string,
  ) {
    super(reason);
    this.name = 'ActivityUnresolvable';
  }
}

/**
 * Parsed LOOSELY and not `.strict()`, for the reason the screen and the medical lane state:
 * zod puts unrecognised KEY NAMES into `ZodError.message`, which the catch below logs, so a
 * strict schema turns a stray field into a log line that can carry text back.
 */
const composeSchema = z.object({
  picks: z.array(
    z.object({
      name: z.string().nullish(),
      age_fit: z.string().nullish(),
      when: z.string().nullish(),
      price: z.string().nullish(),
      source_name: z.string().nullish(),
    }),
  ),
});

const composeJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      maxItems: MAX_PICKS,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age_fit: { type: 'string' },
          when: { type: 'string' },
          price: { type: 'string' },
          source_name: { type: 'string' },
        },
        required: ['name', 'age_fit', 'when', 'source_name'],
      },
    },
  },
  required: ['picks'],
};

/**
 * The search payload — the de-identified query and nothing that could identify the child.
 * Shared with the eval, which replicates this shape.
 */
export function groundUserMessage(query: ActivityQuery): string {
  return JSON.stringify({
    subject: query.subject,
    ...(query.town ? { town: query.town } : {}),
    ...(query.stage ? { stage: query.stage } : {}),
    ...(query.window ? { window: query.window } : {}),
  });
}

/** The compose payload: the same de-identified query plus what the search read. It never
 * carries the parent's message — this stage is blind, which is what makes it structurally
 * unable to echo a name back into a pick. */
export function composeUserMessage(query: ActivityQuery, researchNotes: string): string {
  return JSON.stringify({ ...JSON.parse(groundUserMessage(query)), research_notes: researchNotes });
}

/** The one thing any catch may keep. A provider error can echo the request, so the object
 * never survives (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/**
 * How many real web-search results the model produced. An error result is not a result, so
 * a search that ran and failed counts as zero — which is the point: "did the work, found
 * nothing" is not "was grounded" (rule #11). Mirrors medical.ts and web-grounded.ts.
 */
function countSearchResults(content: Anthropic.ContentBlock[]): number {
  let total = 0;
  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;
    total += block.content.length;
  }
  return total;
}

function researchText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function field(value: unknown): string {
  return typeof value === 'string' ? plainText(value) : '';
}

/**
 * The whole-find rule, as a filter rather than a failure.
 *
 * A pick missing its name, its age fit, its when or its source is not a half-find to be
 * passed on with a caveat — it is a row that cannot be offered, and `search_village` has
 * held exactly this line since it shipped. Dropping it costs the parent one option;
 * shipping it costs them a drive. If the drop empties the list, the turn comes back
 * `no_picks`, which is a true thing Hale can say.
 */
export function toPicks(raw: z.infer<typeof composeSchema>['picks']): ActivityPick[] {
  const picks: ActivityPick[] = [];
  for (const item of raw) {
    const name = field(item.name);
    const ageFit = field(item.age_fit);
    const when = field(item.when);
    const sourceName = field(item.source_name);
    if (name === '' || ageFit === '' || when === '' || sourceName === '') continue;
    const price = field(item.price);
    picks.push({
      name,
      ageFit,
      when,
      price: price === '' ? null : price,
      sourceName,
      // STAMPED HERE. There is no argument through which the model could claim this find
      // was verified by us, which is what makes the two sourcing tiers a property of the
      // data rather than a request in a prompt.
      source: 'web',
    });
  }
  return picks;
}

/** One full attempt. Returns the picks, or throws an {@link ActivityUnresolvable} naming
 * the phase that failed. Never returns an ungrounded or half-finished find. */
async function runActivityOnce(
  client: () => AgentClient,
  query: ActivityQuery,
): Promise<ActivityPick[]> {
  let resolved: AgentClient;
  try {
    resolved = client();
  } catch (err) {
    throw new ActivityUnresolvable('client_unavailable', message(err));
  }

  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill('activity-finder');
  } catch (err) {
    throw new ActivityUnresolvable('skill_unavailable', message(err));
  }

  // Phase 1 — GROUND. Bounded at MAX_SEARCHES: the provider bills per search, and a cost
  // nobody can see is the one that runs away.
  let research: Anthropic.Message;
  try {
    research = await resolved.messages.create({
      model: pickModel(skill.meta.task),
      max_tokens: GROUND_MAX_TOKENS,
      system: skill.instructions,
      tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }],
      messages: [{ role: 'user', content: groundUserMessage(query) }],
    });
  } catch (err) {
    throw new ActivityUnresolvable('ground_failed', message(err));
  }
  if (countSearchResults(research.content) === 0) throw new ActivityUnresolvable('not_grounded');

  // Phase 2 — COMPOSE (blind: the de-identified query and the research, never the message).
  let composed: z.infer<typeof composeSchema>;
  try {
    ({ value: composed } = await forceToolJson({
      client: resolved,
      model: pickModel(skill.meta.task),
      system: skill.instructions,
      userMessage: composeUserMessage(query, researchText(research.content)),
      toolName: 'activity_picks',
      toolDescription: 'Return the concrete programs the search actually found.',
      inputJsonSchema: composeJsonSchema,
      schema: composeSchema,
      maxTokens: COMPOSE_MAX_TOKENS,
    }));
  } catch (err) {
    throw new ActivityUnresolvable('compose_failed', message(err));
  }

  const picks = toPicks(composed.picks);
  if (picks.length === 0) throw new ActivityUnresolvable('no_picks');
  // The never-a-directory ceiling, enforced after the model rather than asked of it. It
  // TRIMS rather than failing: four good finds is a model being generous, and costing the
  // parent all four over the fourth would be the wrong trade. Logged, because a schema
  // whose maxItems is being ignored is worth knowing about (rule #11 — never a silent cut).
  if (picks.length > MAX_PICKS) {
    console.error(
      { returned: picks.length, kept: MAX_PICKS },
      'activity lane: more picks than the ceiling - trimmed',
    );
    return picks.slice(0, MAX_PICKS);
  }
  return picks;
}

function logActivityFailure(err: unknown, attempt: number): void {
  const reason: ActivityFailure | 'unknown' =
    err instanceof ActivityUnresolvable ? err.reason : 'unknown';
  const detail = err instanceof ActivityUnresolvable ? err.detail : message(err);
  console.error({ reason, attempt, detail }, 'activity lane: search could not be completed');
}

/**
 * The production finder.
 *
 * `client` is a RESOLVER for the reason every model stage on this path takes one: the
 * router builds its dependencies for every inbound text, including the ones a
 * deterministic handler answers with no model at all, so a missing key must be an honest
 * `client_unavailable` result rather than a throw at wiring time.
 *
 * ONE RETRY, then an honest failure — the medical lane's shape. A `no_picks` is NOT
 * retried: the search ran and found nothing, and running it again costs the parent
 * latency to be told the same true thing twice.
 */
export function createActivityFinder(client: () => AgentClient): ActivityFinder {
  return {
    async find(query) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return { found: true, picks: await runActivityOnce(client, query) };
        } catch (err) {
          logActivityFailure(err, attempt);
          if (err instanceof ActivityUnresolvable && err.reason === 'no_picks') {
            return { found: false, reason: 'no_picks' };
          }
          if (attempt === 2) {
            return {
              found: false,
              reason: err instanceof ActivityUnresolvable ? err.reason : 'ground_failed',
            };
          }
        }
      }
      /* c8 ignore next -- the loop always returns; this satisfies the type checker. */
      return { found: false, reason: 'ground_failed' };
    },
  };
}
