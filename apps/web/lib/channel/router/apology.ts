import { type AgentClient, pickModel } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { classifyTurnFailure } from './smoke-alarm';

/**
 * THE APOLOGY — the only source of the words a parent gets when a turn breaks on Hale's
 * own side.
 *
 * Founder doctrine, 2026-08-12: no preset message bodies. The line this replaces was a
 * constant — "Something went wrong on my end - nothing was changed. Try me again in a
 * minute." — and every parent who ever hit a bug got the same twelve words, including
 * the ones who hit it twice in a row. It is gone from the failed-turn path.
 *
 * WHY A MODEL IS AVAILABLE TO WRITE IT. This stage is only ever reached on the `defect`
 * branch of {@link classifyTurnFailure}: our own request shape refused, a tool that
 * threw, a dead query, a bug. The model API was REACHABLE for all of them — the coach
 * broke on something else — so there is a composer up to write the sentence. When the
 * provider itself is gone the router defers the whole turn instead and says nothing,
 * because a late real answer beats a punctual canned one (route.ts).
 *
 * WHAT IT SEES IS NOTHING. Not the parent's message, not the family, not what broke.
 * The payload is one constant naming the situation (see {@link apologyUserMessage}), so
 * there is nothing in this request for a bug to leak and nothing for the model to repeat
 * back (rule #1). It also means the sentence cannot pretend to understand what was asked,
 * which is the failure mode a context-carrying apology would invite.
 *
 * THE GATES ARE THE CONTRACT, not a safety net around it. {@link refusals} runs after
 * every attempt, the failures are named, and the names are what the next attempt is told
 * — the same loop the follow-up ask runs, and the reason a cheap tier is enough: the
 * model is not trusted to be right, it is measured, and it gets to try again.
 */

/** One text. 160 GSM-7 characters is a single segment; an apology that costs two was
 * explaining itself. */
export const MAX_APOLOGY_CHARS = 160;

/** Three attempts, then out. A model told its exact violation twice and still failing is
 * not going to be argued into it on the fourth try — and the caller's answer to "no
 * sendable apology" is to re-drive the whole turn, which may not need one at all. */
export const MAX_COMPOSE_ATTEMPTS = 3;

const MAX_TOKENS = 96;

/** No links, held structurally: this stage has no tool that could have given it one, so
 * a URL here is a URL it invented. */
const LINK_SHAPE = /https?:\/\/|www\./i;

/** A sentence terminator with more sentence after it. The trailing one is the sentence's
 * own, which is why the pattern requires something following it. */
const INTERNAL_TERMINATOR = /[.!?]["')\]]?\s+\S/;

/**
 * Why a composed body may not be sent. All mechanical, all fed back to the model
 * verbatim on the next attempt.
 *
 * `invented_number` is the one about MEANING rather than transport: this stage is handed
 * no facts at all, so any digit in the body is an error code, a duration or a count the
 * model made up — and "try again in 5 minutes" is a promise about a fix nobody has
 * scheduled.
 */
export type ApologyRefusal =
  | 'empty'
  | 'over_char_cap'
  | 'not_gsm7'
  | 'carries_link'
  | 'not_one_sentence'
  | 'carries_question'
  | 'invented_number';

/** Every reason this body cannot go out — all of them, not the first, so one recompose
 * can fix everything the model got wrong rather than one thing per round trip. */
export function refusals(body: string): ApologyRefusal[] {
  if (body === '') return ['empty'];
  const found: ApologyRefusal[] = [];
  if (body.length > MAX_APOLOGY_CHARS) found.push('over_char_cap');
  if (smsEncoding(body) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (INTERNAL_TERMINATOR.test(body)) found.push('not_one_sentence');
  if (body.includes('?')) found.push('carries_question');
  if (/\d/.test(body)) found.push('invented_number');
  return found;
}

export interface RejectedApology {
  apology: string;
  problems: ApologyRefusal[];
}

/**
 * The user-turn payload. Shared with the eval, which REPLICATES this request shape.
 *
 * The situation is a NAMED constant rather than a description of what broke, and that is
 * the privacy boundary as well as the product one: the model is told which of Hale's
 * sentences to write, never anything about the family it is written to.
 */
export function apologyUserMessage(rejected: readonly RejectedApology[] = []): string {
  const base = { situation: 'turn_failed_nothing_changed' };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

/**
 * Why no apology was composed. Split from the outage because the caller acts on them
 * differently: `unreachable` means the model went down between the coach failing and this
 * running, so the turn is deferred and re-driven; the rest mean Hale could not write a
 * sendable sentence, which is a deploy or prompt problem, and the turn is deferred too —
 * but named as what it was.
 */
export type ApologyFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'gate_exhausted';

export type ApologyOutcome =
  | { status: 'composed'; reply: string }
  /** The provider is gone. Not a failure to compose — a reclassification of the whole
   * turn, which the router defers into the retry queue (rule #11: the caller must be
   * able to tell these apart, so they are not one bucket). */
  | { status: 'unreachable' }
  | { status: 'unavailable'; reason: ApologyFallback };

export interface TurnApology {
  compose(): Promise<ApologyOutcome>;
}

const apologySchema = z.object({ apology: z.string() });

const apologyJsonSchema = {
  type: 'object',
  properties: { apology: { type: 'string' } },
  required: ['apology'],
} as const;

/** The only thing any catch here may log: a provider error can carry the request back,
 * so the message survives and the object does not (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function unavailable(reason: ApologyFallback, detail?: string): ApologyOutcome {
  console.error({ reason, detail }, 'turn apology: no sentence composed');
  return { status: 'unavailable', reason };
}

/**
 * The production composer.
 *
 * `client` is a RESOLVER rather than a client, for the reason the general answer's is:
 * the router builds its dependencies for EVERY inbound text, including the ones a
 * deterministic handler answers with no model at all, so constructing one at wiring time
 * would make a missing key break approvals — and deferring it buys the honest
 * `client_unavailable` outcome instead of a thrown route.
 */
export function createTurnApology(client: () => AgentClient): TurnApology {
  return {
    async compose() {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unavailable('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('turn-apology');
      } catch (err) {
        return unavailable('skill_unavailable', message(err));
      }

      const rejected: RejectedApology[] = [];
      for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            model: pickModel(skill.meta.task),
            system: skill.instructions,
            userMessage: apologyUserMessage(rejected),
            toolName: 'apology',
            toolDescription: 'Return the one sentence the parent gets back.',
            inputJsonSchema: apologyJsonSchema,
            schema: apologySchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.apology;
        } catch (err) {
          // The SAME reading the router used on the coach's failure, so the two stages
          // cannot disagree about whether the provider is there. An outage does not get
          // three tries: it will not have resolved by the third, and the retry queue is
          // the right place to wait.
          if (classifyTurnFailure(err) === 'model_unreachable') {
            console.error(
              { detail: message(err) },
              'turn apology: the model went down mid-apology — deferring the turn',
            );
            return { status: 'unreachable' };
          }
          return unavailable('model_failed', message(err));
        }

        const body = plainText(raw);
        const problems = refusals(body);
        if (problems.length === 0) return { status: 'composed', reply: body };
        rejected.push({ apology: body, problems });
      }

      return unavailable('gate_exhausted', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}
