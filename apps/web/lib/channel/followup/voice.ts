import { type AgentClient, pickModel } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE FOLLOW-UP VOICE — the only source of the words in a follow-up ask.
 *
 * Founder doctrine, 2026-08-12: no preset message bodies. There is no fixed line under
 * this composer waiting to catch a bad day, and that absence is the design rather than
 * an oversight. A canned fallback is a message Hale sends when it is not really paying
 * attention, and a check-in that arrives on time but in a voice the parent has read four
 * times already is worse than one that arrives a day late. So a refused body is composed
 * AGAIN with the refusal handed back, and a composer that cannot produce a sendable ask
 * defers — the sweep keeps the claim unspent and tries on the next tick.
 *
 * WHAT IT SEES IS ALMOST NOTHING. The kind of follow-up, and for an activity the title
 * as it sits on the calendar. No child, no name, no age, no town, no week, no transcript
 * — none of it is loaded, so none of it can be embellished into the message (rule #1).
 * The private-item drop upstream means a teen's or a health item never reaches this
 * function at all, so the one fact it does see is one a parent may safely be shown.
 *
 * THE GATES ARE THE CONTRACT, not a safety net around it. {@link refusals} is checked
 * after every attempt, the failures are named, and the names are what the next attempt
 * is told. That loop is the reason a cheap tier is enough here: the model is not trusted
 * to be right, it is measured, and it gets to try again.
 */

/** One text. 160 GSM-7 characters is a single segment, and a check-in that costs two is
 * a check-in that was trying to say something else as well. */
export const MAX_ASK_CHARS = 160;

/** Three attempts, then defer. A model that has been told its exact violation twice and
 * still fails is not going to be argued into it on the fourth try — and the sweep runs
 * again in an hour, which is a cheaper place to retry than inside one cron request. */
export const MAX_COMPOSE_ATTEMPTS = 3;

const MAX_TOKENS = 128;

/** No links, held structurally: this stage has no tool that could have given it one, so
 * a URL here is a URL it invented. */
const LINK_SHAPE = /https?:\/\/|www\./i;

export type FollowupVoiceRequest =
  | { kind: 'activity'; activity: string }
  | { kind: 'intro' };

/**
 * Why a composed body may not be sent. Every one is mechanical, and every one is fed
 * back to the model verbatim on the next attempt.
 *
 * `subject_missing` and `invented_number` are the two that are about MEANING rather than
 * transport, and they are the pinned-meaning contract's structural half: a message that
 * does not contain the activity's own name is not provably about that activity, and a
 * number the model was never given is a time, date or count it made up.
 */
export type AskRefusal =
  | 'empty'
  | 'over_char_cap'
  | 'not_gsm7'
  | 'carries_link'
  | 'not_one_question'
  | 'subject_missing'
  | 'invented_number';

/** Every reason this body cannot go out — all of them, not the first, so one recompose
 * can fix everything the model got wrong rather than one thing per round trip. */
export function refusals(body: string, request: FollowupVoiceRequest): AskRefusal[] {
  const found: AskRefusal[] = [];
  if (body === '') return ['empty'];
  if (body.length > MAX_ASK_CHARS) found.push('over_char_cap');
  if (smsEncoding(body) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if ((body.match(/\?/g) ?? []).length !== 1) found.push('not_one_question');

  // The title is stripped before the digit check rather than after: "Gym 2 Grow" is the
  // name of the place, and a number Hale itself put in front of the model is not one the
  // model invented.
  let withoutSubject = body;
  if (request.kind === 'activity') {
    if (!body.toLowerCase().includes(request.activity.toLowerCase())) found.push('subject_missing');
    withoutSubject = body.replace(new RegExp(escapeRegExp(request.activity), 'gi'), ' ');
  }
  if (/\d/.test(withoutSubject)) found.push('invented_number');
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RejectedAttempt {
  ask: string;
  problems: AskRefusal[];
}

/**
 * The user-turn payload. Shared with the eval, which REPLICATES this request shape.
 *
 * `rejected` is omitted entirely on a first attempt so the common request is the small
 * one — and so a cached eval key for the plain ask is not disturbed by the recompose
 * machinery existing.
 */
export function followupVoiceUserMessage(
  request: FollowupVoiceRequest,
  rejected: readonly RejectedAttempt[] = [],
): string {
  const base =
    request.kind === 'activity'
      ? { kind: 'activity', activity: request.activity }
      : { kind: 'intro' };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

/**
 * Why no ask was composed. Four separate stories, because they call for four different
 * responses: `client_unavailable` is configuration, `skill_unavailable` is a deploy bug,
 * `model_failed` is an outage, and `gate_exhausted` is a prompt problem — the only one of
 * the four that is anybody's fault here.
 */
export type ComposeDeferral =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'gate_exhausted';

export type FollowupVoiceOutcome =
  | { status: 'composed'; body: string }
  /** No ask this tick. The caller MUST leave its claim unspent (rule #11): a deferral is
   * a retry, and a retry that has consumed its idempotency key never happens. */
  | { status: 'deferred'; reason: ComposeDeferral };

export interface FollowupVoice {
  compose(request: FollowupVoiceRequest): Promise<FollowupVoiceOutcome>;
}

const askSchema = z.object({ ask: z.string() });

const askJsonSchema = {
  type: 'object',
  properties: { ask: { type: 'string' } },
  required: ['ask'],
} as const;

/** The only thing any catch here may log: a provider error can carry the request back,
 * so the message survives and the object does not (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function deferred(reason: ComposeDeferral, detail?: string): FollowupVoiceOutcome {
  console.error({ reason, detail }, 'followup voice: no ask composed, deferring to the next tick');
  return { status: 'deferred', reason };
}

/**
 * The production composer.
 *
 * `client` is a RESOLVER rather than a client, for the reason the general answer's is:
 * the sweep builds its dependencies on every cron tick including the many where nothing
 * is due, so constructing a client at wiring time would turn a missing key into a broken
 * cron — and deferring it buys the honest `client_unavailable` outcome instead.
 */
export function createFollowupVoice(client: () => AgentClient): FollowupVoice {
  return {
    async compose(request) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return deferred('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('followup-voice');
      } catch (err) {
        return deferred('skill_unavailable', message(err));
      }

      const rejected: RejectedAttempt[] = [];
      for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            model: pickModel(skill.meta.task),
            system: skill.instructions,
            userMessage: followupVoiceUserMessage(request, rejected),
            toolName: 'ask',
            toolDescription: 'Return the one short check-in question.',
            inputJsonSchema: askJsonSchema,
            schema: askSchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.ask;
        } catch (err) {
          // An outage does not get three tries. It will not have resolved by the third,
          // and the sweep's next tick is an hour away — which is the right place to wait.
          return deferred('model_failed', message(err));
        }

        const body = plainText(raw);
        const problems = refusals(body, request);
        if (problems.length === 0) return { status: 'composed', body };
        rejected.push({ ask: body, problems });
      }

      return deferred('gate_exhausted', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}
