import { type AgentClient, pickModel } from '@hale/agent';
import { type CoachingPlaybook, type FamilyStage, goDeeperNames } from '@hale/types';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { modelIsUnreachable } from '~/lib/channel/router/smoke-alarm';
import { reachesForTheHealthLine } from '~/lib/channel/off-domain/copy';
import { smsEncoding, smsSegments, smsUnits, smsUnitsBudget } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type PlanCheckInDays,
  type PlanTopic,
  isPlanCheckInDays,
} from './topics';

/**
 * THE PLAN — the only place in this arc a model writes at length, and the only one that
 * writes about a METHOD.
 *
 * Two properties matter more than everything else here:
 *
 *   IT IS GROUNDED ON A CURATED PLAYBOOK, not on model knowledge. The Ferber intervals,
 *   the 3-day method, the Canadian priority allergens — all of it comes from
 *   @hale/types/coaching-playbooks, which is source-verified and versioned. The model's
 *   job is to SELECT and PERSONALISE, never to supply the method. An earlier version
 *   scored 5/5 with Opus improvising the content, which is the well-dressed version of
 *   the failure: unversioned medical instructions, different every send, traceable to
 *   nothing.
 *
 *   THERE IS NO FALLBACK BODY. A refusal from the gates below is fed back to the model
 *   as a named violation and the plan is RECOMPOSED (bounded). Exhaust the attempts, or
 *   find the provider unreachable, and this DEFERS — the caller throws, the drain
 *   redrives, and the plan lands late. A late real plan beats a canned apology, and a
 *   canned apology is what ships every time composition is hard if one exists at all.
 *
 * PRIVACY. The question, the child's AGE and the playbook go to the model. No name, no
 * id, no location, no schedule. Nothing here logs the question.
 */

/**
 * The ceiling on ONE plan message, in segments.
 *
 * Three, where a coach reply gets two. A reply interrupts; a plan was asked for twice,
 * and a stage trimmed to two sentences is the amputation this arc exists to undo.
 */
export const MAX_PLAN_SEGMENTS = 3;

/** The plan is two or three messages. One is the answer they already had; four is a
 * document, and a document is what the app was for. */
export const MIN_PLAN_MESSAGES = 2;
export const MAX_PLAN_MESSAGES = 3;

/**
 * How many times a refused plan is rewritten before the turn defers.
 *
 * Three, because the violations handed back are specific ("stage 2 is 4 segments",
 * "names Dr. Someone, who is not on the list") and a model that cannot fix a stated
 * mechanical fault in two more tries is not going to on the fourth — at which point
 * deferring to a retry with a fresh context is the better spend.
 */
export const MAX_COMPOSE_ATTEMPTS = 3;

/** Room for three messages plus the JSON around them. */
const MAX_TOKENS = 2048;

/**
 * A DOSE, structurally. The skill forbids these and the playbooks contain none, but a
 * prompt is a request: a number followed by a unit of medicine is the one shape whose
 * cost is a parent measuring something out on Hale's word.
 */
const DOSING_SHAPE = /\b\d+(?:\.\d+)?\s?(?:mg|ml|mcg|milligrams?|millilitres?|milliliters?)\b/i;

/**
 * A link, including the BARE-DOMAIN form.
 *
 * `https?://` alone is not enough here, and the playbooks are why: a vetted creator's
 * credential legitimately contains "youtube.com/c/EmmaHubbard", so the one thing the
 * model is most likely to copy out of its grounding is a URL with no scheme on it.
 */
const LINK_SHAPE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ca|org|net|io|co|tv)\b/i;

/** A person Hale names. Only the playbook's vetted creators may be cited, so anything
 * matching a title-cased "Dr X" or a "<Name> says" shape is checked against the list. */
const NAMED_PERSON = /\b(?:Dr\.?|Doctor|Professor|Prof\.?)\s+[A-Z][a-z]+/g;

/**
 * Why a plan did not go out this turn. Six stories, because they are six different
 * problems: three configuration/outage shapes, one "the model wrote something that must
 * not be sent and could not fix it", and one wrong-shape.
 */
export type PlanFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_unreachable'
  | 'model_failed'
  | 'gates_exhausted';

export type PlanComposeOutcome =
  /** Ready to send, in order, with the day Hale promised to come back. */
  | { status: 'composed'; messages: string[]; checkInDays: PlanCheckInDays }
  /**
   * Nothing sendable after every attempt, or nothing to compose with. NOT a message —
   * there is no fallback body on this path. The caller defers and the drain redrives.
   * `violations` is the last set the gates raised, so a deferral says what went wrong.
   */
  | { status: 'deferred'; reason: PlanFallback; violations: readonly string[] };

/** What the plan is written about. Assembled by the caller so this module reads no
 * tables and can be exercised without one. */
export interface PlanGrounding {
  topic: PlanTopic;
  /** The parent's own words. The real brief — `topic` is only the category. */
  question: string;
  /** The child the question was about, or null for a household question. */
  child: { ageMonths: number; stage: FamilyStage } | null;
  /** The curated method content. THE source for every claim in the plan. */
  playbook: CoachingPlaybook;
  /** A few things Hale already knows, bounded by the caller. Plain sentences. */
  facts: string[];
  /** The weekday each allowed check-in offset lands on, in the family's own clock, so
   * the model promises a day it can name rather than doing calendar arithmetic. */
  checkInDayNames: Record<PlanCheckInDays, string>;
}

export interface PlanComposer {
  compose(grounding: PlanGrounding): Promise<PlanComposeOutcome>;
}

/**
 * THREE NAMED STRING FIELDS plus the chosen offset, not an array.
 *
 * The first live recording came back with `messages` set to a JSON-ENCODED STRING; the
 * plan inside was good and `z.array(z.string())` would have thrown it away. A field
 * typed `string` has no second representation to choose between, and two-required-plus-
 * one-optional IS the two-or-three rule, held by the schema rather than checked after.
 *
 * `checkInDays` is structured for the same reason the topic is: the prose line ("I'll
 * check in Friday") and the ledger row's `due_at` both derive from this ONE field, so
 * the day Hale said and the day it comes back cannot disagree. Parsing the day back out
 * of the prose would be two readers of one fact.
 */
const planSchema = z.object({
  first: z.string(),
  second: z.string(),
  third: z.string().optional(),
  checkInDays: z.number().int(),
});

const planJsonSchema = {
  type: 'object',
  properties: {
    first: { type: 'string', description: 'The first plan message.' },
    second: { type: 'string', description: 'The second plan message.' },
    third: { type: 'string', description: 'The third plan message. Omit for a two-message plan.' },
    checkInDays: {
      type: 'integer',
      enum: [2, 3, 4, 5],
      description:
        'How many days from today Hale should check back in. Your final message must promise this day by name.',
    },
  },
  required: ['first', 'second', 'checkInDays'],
} as const;

/** The plan's messages, in order. Exported because the eval REPLICATES the request
 * shape and must assemble it identically. */
export function planMessages(value: {
  first: string;
  second: string;
  third?: string;
}): string[] {
  return [value.first, value.second, ...(value.third === undefined ? [] : [value.third])];
}

/**
 * The user-turn payload — the playbook, whole, plus who it is for.
 *
 * The creators are projected rather than passed raw: their curated `credential` carries
 * a channel URL, and handing a model a URL and then refusing every URL is a trap rather
 * than a rule. `verified` is dropped too — it is provenance for us, not for a parent.
 */
export function planUserMessage(grounding: PlanGrounding): string {
  const { playbook } = grounding;
  return JSON.stringify({
    question: grounding.question,
    child: grounding.child,
    facts: grounding.facts,
    checkInDayNames: grounding.checkInDayNames,
    playbook: {
      topic: playbook.topic,
      primaryMethod: playbook.primaryMethod,
      alternativeMethod: playbook.alternativeMethod,
      readinessSigns: playbook.readinessSigns,
      neverDo: playbook.neverDo,
      doctorTriggers: playbook.doctorTriggers,
      goDeeper: playbook.goDeeper.map((creator) => ({
        name: creator.name,
        credential: withoutChannelUrl(creator.credential),
        goodFor: creator.goodFor,
      })),
    },
  });
}

/** Drop the trailing "; youtube.com/c/Someone" clause a curated credential carries.
 * Targeted at the trailing URL only: the credential's own semicolons (degrees, years,
 * practice) must survive, so this is not a split. */
export function withoutChannelUrl(credential: string): string {
  return credential.replace(/;\s*(?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\/\S*\s*$/i, '');
}

/** The only thing any catch here may log: a provider error can carry the request back,
 * so the message survives and the object does not (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/**
 * Everything wrong with this plan, named the way the model needs to hear it.
 *
 * Returns an EMPTY array for a sendable plan. Each string is written as an instruction
 * rather than a diagnosis, because its second reader is the model on the next attempt —
 * "stage 2 is 4 segments, cut it to about 400 characters" is actionable where
 * "over_budget" is not.
 */
export function planViolations(
  raw: readonly string[],
  grounding: PlanGrounding,
  checkInDays: number,
): string[] {
  const violations: string[] = [];
  const messages = raw.map(plainText).filter((body) => body !== '');

  if (messages.length < MIN_PLAN_MESSAGES || messages.length > MAX_PLAN_MESSAGES) {
    violations.push(
      `The plan came back as ${messages.length} usable message(s); it must be exactly 2 or 3, each non-empty.`,
    );
  }
  if (!isPlanCheckInDays(checkInDays)) {
    violations.push(`checkInDays was ${checkInDays}; it must be 2, 3, 4 or 5.`);
  }

  messages.forEach((body, index) => {
    const stage = index + 1;
    if (smsSegments(body) > MAX_PLAN_SEGMENTS) {
      // Named to the character, and phrased as MOVE rather than CUT. The live corpus is
      // why: on the densest fixture (the allergen protocol) three rounds of "cut it to
      // about 400 characters" produced 476, 470, 476 — the model was right that the
      // content was load-bearing and wrong about where it had to live. A stage that is
      // 20 characters over has a sentence in the wrong message, not a sentence too many.
      //
      // Both numbers are in the currency the carrier bills THIS body in, because the
      // gate above is a SEGMENT count and a UCS-2 body blows three segments at 202 units
      // where a GSM-7 one takes 460. Measured against a fixed 459-character limit, one
      // emoji told the model it was "-249 over the limit".
      const units = smsUnits(body);
      const limit = smsUnitsBudget(body, MAX_PLAN_SEGMENTS);
      violations.push(
        `Message ${stage} is ${units} characters, ${units - limit} over the ${limit} limit, and the WHOLE plan is refused for it. Move a sentence into another message rather than deleting the content.`,
      );
    }
    if (smsEncoding(body) !== 'gsm7') {
      violations.push(
        `Message ${stage} contains a character that doubles the cost to send (a curly quote, a dash, or an emoji). Use plain ASCII.`,
      );
    }
    if (LINK_SHAPE.test(body)) {
      violations.push(`Message ${stage} contains a link or a web address. Never send one.`);
    }
    if (DOSING_SHAPE.test(body)) {
      violations.push(
        `Message ${stage} names a dose. Hale never gives one, not even over the counter.`,
      );
    }
    if (reachesForTheHealthLine(body) && !playbookSanctionsTheHealthLine(grounding.playbook)) {
      // The siren, treated as a violation to REWRITE rather than a body to swap out.
      // This is a guidance topic — the parent asked how to do a thing — so a phone
      // number here is the model losing its nerve, and the fix is the plan it was
      // asked for, not a referral in its place.
      //
      // UNLESS the playbook itself says the number. Solids is the case that forced
      // this: its verified doctorTriggers open "Call 911 now, not the doctor: trouble
      // breathing... after eating", because anaphylaxis IS the emergency the blanket
      // rule was written to keep Hale from inventing. Where the curated content says
      // it, Hale may say it; everywhere else it may not. The authority is the same one
      // that grounds every other claim in the plan.
      violations.push(
        `Message ${stage} gives a phone number (811 or 911). This is a how-to question, not an emergency: name the SITUATION worth a doctor's call instead, with no number.`,
      );
    }
  });

  // The method has to be named. It is the founder's requirement and the parent's only
  // handle on what they are doing — a plan that will not say "the Ferber method" is a
  // plan they cannot look up or tell their partner about.
  const whole = messages.join(' ');
  if (!namesTheMethod(whole, grounding.playbook)) {
    violations.push(
      `The plan never names the method. Say "${grounding.playbook.primaryMethod.name}" in the first message.`,
    );
  }

  // Only the vetted creators may be cited, and at most one.
  const allowed = goDeeperNames(grounding.topic).map((name) => name.toLowerCase());
  const cited = [...whole.matchAll(NAMED_PERSON)].map((match) => match[0]);
  const unvetted = cited.filter(
    (name) => !allowed.some((ok) => ok.includes(name.replace(/^(Dr\.?|Doctor|Professor|Prof\.?)\s+/i, '').toLowerCase())),
  );
  if (unvetted.length > 0) {
    violations.push(
      `The plan names ${unvetted.join(', ')}, who is not on the approved list. Only these names may appear, and only one of them: ${goDeeperNames(grounding.topic).join('; ')}.`,
    );
  }
  const mentioned = goDeeperNames(grounding.topic).filter((name) =>
    whole.toLowerCase().includes(firstNameToken(name)),
  );
  if (mentioned.length > 1) {
    violations.push(
      `The plan names ${mentioned.length} people to follow up with. Name at most one, in the last message.`,
    );
  }

  // The promised day has to appear, because the promise IS the feature: the ledger row
  // will come back on it whether or not the parent was told.
  const promised = isPlanCheckInDays(checkInDays)
    ? grounding.checkInDayNames[checkInDays]
    : undefined;
  if (promised && !whole.toLowerCase().includes(promised.toLowerCase())) {
    violations.push(
      `The plan never says when you will check back. Your last message must promise the day: "${promised}".`,
    );
  }

  return violations;
}

/** Whether this playbook's own verified triggers name an emergency number. Read from
 * the curated content rather than a topic allowlist, so adding a playbook cannot
 * silently widen where Hale is allowed to say 911. */
function playbookSanctionsTheHealthLine(playbook: CoachingPlaybook): boolean {
  return playbook.doctorTriggers.some((trigger) => reachesForTheHealthLine(trigger));
}

/** The first distinctive token of a creator's name, lowercased — "emma" from "Emma
 * Hubbard", "doctors bjorkman" from the parenthesised full form. Matching on the whole
 * curated string would miss every natural way a sentence introduces someone. */
function firstNameToken(name: string): string {
  const bare = name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
  return bare.startsWith('the ') ? bare.slice(4) : bare;
}

/**
 * Whether the plan names a method the playbook actually contains.
 *
 * EITHER method counts, and that is not a loosening. The playbooks say when the
 * alternative is the right call — sleep's own age gate ends "toddlers in beds usually
 * need the chair method instead" — so a plan that reads the child's situation and
 * recommends the alternative is the playbook working, not a plan ducking its method.
 * What is forbidden is naming NEITHER.
 *
 * Matched on distinctive tokens rather than the whole curated label, because the
 * parent-facing name is a phrase and not a string id: "the Ferber method" has to satisfy
 * "Graduated check-ins (Ferber method)", and "the iron-first approach" has to satisfy
 * "Iron-first solids with early-and-often allergen introduction".
 */
export function namesTheMethod(text: string, playbook: CoachingPlaybook): boolean {
  const haystack = text.toLowerCase();
  return [
    ...methodTokens(playbook.primaryMethod.name),
    ...methodTokens(playbook.alternativeMethod.name),
  ].some((token) => haystack.includes(token));
}

function methodTokens(rawName: string): string[] {
  const name = rawName.toLowerCase();
  const tokens = [name];
  const parenthesised = name.match(/\(([^)]+)\)/)?.[1];
  if (parenthesised) tokens.push(parenthesised);
  const leading = name.split('(')[0]?.trim();
  if (leading) tokens.push(leading);
  // The head word, when it is distinctive enough to be one: "iron-first", "graduated",
  // "3-day". Four characters keeps "the" and "a" out of it.
  const head = leading?.split(/\s+/)[0];
  if (head && head.length >= 4) tokens.push(head);
  return tokens;
}

/**
 * The production composer, with the recompose loop.
 *
 * `client` is a RESOLVER for the reason the other composers' are: the router builds its
 * dependencies for every inbound text, including the ones answered with no model at
 * all, so constructing a client at wiring time would make a missing key break
 * approvals.
 */
export function createPlanComposer(client: () => AgentClient): PlanComposer {
  return {
    async compose(grounding) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return deferred('client_unavailable', [message(err)]);
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('coach-plan');
      } catch (err) {
        return deferred('skill_unavailable', [message(err)]);
      }

      let violations: string[] = [];
      for (let attempt = 1; attempt <= MAX_COMPOSE_ATTEMPTS; attempt += 1) {
        let value: z.infer<typeof planSchema>;
        try {
          const result = await forceToolJson({
            client: resolved,
            model: pickModel(skill.meta.task),
            system: skill.instructions,
            userMessage: retryUserMessage(planUserMessage(grounding), violations),
            toolName: 'plan',
            toolDescription:
              'Return the plan as two or three text messages in order, plus how many days from today to check back.',
            inputJsonSchema: planJsonSchema,
            schema: planSchema,
            maxTokens: MAX_TOKENS,
          });
          value = result.value;
        } catch (err) {
          // An outage is not a prompt problem, and retrying it here would spend the
          // attempts that exist for prompt problems. The drain redrives the whole turn.
          if (modelIsUnreachable(err)) return deferred('model_unreachable', [message(err)]);
          return deferred('model_failed', [message(err)]);
        }

        const raw = planMessages(value);
        violations = planViolations(raw, grounding, value.checkInDays);
        if (violations.length === 0 && isPlanCheckInDays(value.checkInDays)) {
          return {
            status: 'composed',
            messages: raw.map(plainText).filter((body) => body !== ''),
            checkInDays: value.checkInDays,
          };
        }
        console.error(
          { attempt, violations: violations.length, topic: grounding.topic },
          'coach plan: refused by the gates, recomposing',
        );
      }
      return deferred('gates_exhausted', violations);
    },
  };
}

function deferred(reason: PlanFallback, violations: readonly string[]): PlanComposeOutcome {
  console.error({ reason, violations }, 'coach plan: deferring rather than sending a canned line');
  return { status: 'deferred', reason, violations };
}

/**
 * The next attempt's user turn: the same grounding, plus what was wrong last time.
 *
 * Appended to the payload rather than sent as a second conversational turn so the
 * request stays single-shot and content-addressable — which is what lets the eval cache
 * each attempt exactly (the retry has a different payload, so it has a different key).
 */
export function retryUserMessage(base: string, violations: readonly string[]): string {
  if (violations.length === 0) return base;
  return JSON.stringify({
    ...(JSON.parse(base) as Record<string, unknown>),
    rejectedLastAttempt: violations,
  });
}
