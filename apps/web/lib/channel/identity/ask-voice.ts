import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { ASSENT_ACK } from '~/lib/channel/intake/copy';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE IDENTITY ASK — the only source of the words in a request for the parent's own
 * name or email address.
 *
 * TWO CALLERS, ONE VOICE. Intake asks for a name at the moment watching is switched on;
 * the intros sweep asks for whatever it is missing at the moment two families have both
 * said yes. They are the same sentence with a different reason attached, and giving them
 * one skill is what stops Hale developing two ways of asking a parent what to call them.
 *
 * Founder doctrine, 2026-08-12: no preset message bodies. There is no fixed line under
 * this composer waiting to catch a bad day. A refused body is composed AGAIN with the
 * refusal handed back, and a composer that cannot produce a sendable ask DEFERS — the
 * caller leaves its claim unspent and the next tick tries again. What that costs is
 * bounded and named at both call sites: intake sends its acknowledgment without the
 * trailing question, and the sweep holds the pair open for another tick.
 *
 * WHAT IT SEES IS ALMOST NOTHING (rule #1). What is missing, and why. No child, no age,
 * no area, no transcript — and, for the introduction, not one fact about the other
 * household. A composer that was never handed the counterpart cannot name them, which is
 * the same structural argument the coarse card rests on: the privacy rule is in what the
 * function takes, not in what the prose promises.
 */

/** One text. The intros ask is a message of its own, so it gets the whole segment. */
export const MAX_ASK_CHARS = 160;

/**
 * The `getting_started` ask is APPENDED to {@link ASSENT_ACK} rather than sent on its
 * own, so its budget is whatever is left of the one segment after that sentence and the
 * space joining them. Derived, never typed in: an edit to the ack moves this ceiling
 * with it instead of silently pushing the consent turn into two segments.
 */
export const MAX_TAIL_ASK_CHARS = MAX_ASK_CHARS - ASSENT_ACK.length - 1;

/** Three attempts, then defer. A model told its exact violation twice will not be argued
 * into it on the fourth try, and both callers have a cheaper place to retry. */
export const MAX_COMPOSE_ATTEMPTS = 3;

const MAX_TOKENS = 128;

/** No links, held structurally: this stage has no tool that could have given it one, so
 * a URL here is a URL it invented. */
const LINK_SHAPE = /https?:\/\/|www\./i;

/** The parent facts Hale will ask for rather than invent. A guessed name is the wrong
 * name in every message after it; a guessed address reaches a stranger. */
export type IdentityGap = 'name' | 'email';

/**
 * Why Hale is asking, which is most of what the message says.
 *
 * `getting_started` rides on the end of the consent acknowledgment. `introduction` is a
 * message of its own, days after the parent agreed to something Hale then could not do —
 * so it has to say which thing, or it reads as a company harvesting an address.
 */
export type IdentityAskReason = 'getting_started' | 'introduction';

export interface IdentityAskRequest {
  reason: IdentityAskReason;
  /** Non-empty. An ask with nothing to ask for is a bug at the call site, not a message. */
  missing: readonly IdentityGap[];
}

/**
 * Why a composed body may not be sent. Every one is mechanical, and every one is fed
 * back to the model on the next attempt.
 *
 * The three `*_word_missing` refusals are the pinned-meaning contract's structural half.
 * "What should I call you" is good English that never says `name`, and there is no way
 * to prove from the outside that it asked for one — so the word is required and the
 * refusal says so. `introduction_word_missing` is the same move on the reason: without
 * it, a request for an address arriving days after a yes is indistinguishable from a
 * cold data-collection text.
 */
export type IdentityAskRefusal =
  | 'empty'
  | 'over_char_cap'
  | 'not_gsm7'
  | 'carries_link'
  | 'too_many_questions'
  | 'not_a_sentence'
  | 'name_word_missing'
  | 'email_word_missing'
  | 'introduction_word_missing'
  | 'carries_address'
  | 'invented_number';

/** The ceiling this request is judged against — the tail budget when the ask is being
 * appended to the acknowledgment, the whole segment when it stands alone. */
export function askCharCap(request: IdentityAskRequest): number {
  return request.reason === 'getting_started' ? MAX_TAIL_ASK_CHARS : MAX_ASK_CHARS;
}

/**
 * Every reason this body cannot go out — all of them, not the first, so one recompose
 * can fix everything the model got wrong rather than one thing per round trip.
 *
 * AT MOST one question mark, not exactly one. The sibling calendar ask learned this
 * live: the model wrote the better message as a statement ending in an instruction
 * ("text me your first name and I'll make the introduction"), three times out of three,
 * and forcing an interrogative on it made the copy worse. What has to be stopped is the
 * INTERROGATION, which is the second question mark. Whether it actually asks is held by
 * the required-word refusals below.
 */
export function identityAskRefusals(
  body: string,
  request: IdentityAskRequest,
): IdentityAskRefusal[] {
  const found: IdentityAskRefusal[] = [];
  if (body === '') return ['empty'];
  if (body.length > askCharCap(request)) found.push('over_char_cap');
  if (smsEncoding(body) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if ((body.match(/\?/g) ?? []).length > 1) found.push('too_many_questions');

  // A WHOLE SENTENCE, capitalised. Found live on the first recorded run: told that the
  // getting_started ask was "the tail of a message", the model wrote the tail of a
  // SENTENCE — "- and your name so I know what to call you." — which the shell then joined
  // after a full stop into "...STOP always works. - and your name so...". Every other gate
  // passed it. The ask is appended AFTER a completed sentence, so it has to begin one.
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');

  const lower = body.toLowerCase();
  if (request.missing.includes('name') && !lower.includes('name')) found.push('name_word_missing');
  if (request.missing.includes('email') && !lower.includes('email')) {
    found.push('email_word_missing');
  }
  if (request.reason === 'introduction' && !lower.includes('introduc')) {
    found.push('introduction_word_missing');
  }

  // An '@' is only ever an example address here, and an example address is invented.
  if (body.includes('@')) found.push('carries_address');
  if (/\d/.test(body)) found.push('invented_number');
  return found;
}

export interface RejectedIdentityAsk {
  ask: string;
  problems: IdentityAskRefusal[];
}

/**
 * The user-turn payload. Shared with the eval, which REPLICATES this request shape.
 *
 * `rejected` is omitted entirely on a first attempt so the common request is the small
 * one — and so a cached eval key for the plain ask is not disturbed by the recompose
 * machinery existing.
 */
export function identityAskUserMessage(
  request: IdentityAskRequest,
  rejected: readonly RejectedIdentityAsk[] = [],
): string {
  const base = { reason: request.reason, missing: [...request.missing] };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

/**
 * Why no ask was composed. Four separate stories, because they call for four different
 * responses: `client_unavailable` is configuration, `skill_unavailable` is a deploy bug,
 * `model_failed` is an outage, and `gate_exhausted` is a prompt problem — the only one
 * of the four that is anybody's fault here.
 */
export type IdentityAskDeferral =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'gate_exhausted';

export type IdentityAskOutcome =
  | { status: 'composed'; body: string }
  /** No ask this turn. The caller MUST leave its claim unspent (rule #11): a deferral is
   * a retry, and a retry that has consumed its idempotency key never happens. */
  | { status: 'deferred'; reason: IdentityAskDeferral };

export interface IdentityAskVoice {
  compose(request: IdentityAskRequest): Promise<IdentityAskOutcome>;
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

function deferred(reason: IdentityAskDeferral, detail?: string): IdentityAskOutcome {
  console.error({ reason, detail }, 'identity ask: no ask composed, deferring');
  return { status: 'deferred', reason };
}

/**
 * The production composer.
 *
 * `client` is a RESOLVER rather than a client, for the reason the follow-up's is: both
 * callers build these dependencies on paths that mostly never reach a model — every
 * inbound text, every sweep tick — so constructing a client at wiring time would turn a
 * missing key into a broken intake, and deferring it buys the honest
 * `client_unavailable` outcome instead.
 */
export function createIdentityAskVoice(client: () => AgentClient): IdentityAskVoice {
  return {
    async compose(request) {
      if (request.missing.length === 0) {
        // Nothing to ask for. The call sites decide WHETHER to ask by reading the
        // family's own row, so an empty list means one of them asked anyway.
        return deferred('gate_exhausted', 'no gap to ask about');
      }

      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return deferred('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('identity-ask');
      } catch (err) {
        return deferred('skill_unavailable', message(err));
      }

      const rejected: RejectedIdentityAsk[] = [];
      for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            model: pickModel(skill.meta.task),
            system: skill.instructions,
            userMessage: identityAskUserMessage(request, rejected),
            toolName: 'ask',
            toolDescription: "Return the one text asking for the parent's own detail.",
            inputJsonSchema: askJsonSchema,
            schema: askSchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.ask;
        } catch (err) {
          // An outage does not get three tries. It will not have resolved by the third,
          // and both callers have a later tick to wait in.
          return deferred('model_failed', message(err));
        }

        const body = plainText(raw);
        const problems = identityAskRefusals(body, request);
        if (problems.length === 0) return { status: 'composed', body };
        rejected.push({ ask: body, problems });
      }

      return deferred('gate_exhausted', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}

let cached: Anthropic | undefined;

/**
 * The shared client, resolved LAZILY and THROWING rather than returning null — the same
 * shape the calendar voice uses, and for the same reason. Both callers construct these
 * deps on paths that mostly never reach a model (every inbound text, every sweep tick),
 * so a missing key must not break construction; throwing here is what buys the single
 * named `client_unavailable` deferral instead of a crash at wiring time.
 */
export function identityAskClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  cached ??= new Anthropic({ apiKey });
  return cached;
}

/** The composer both production callers use. */
export function productionIdentityAskVoice(): IdentityAskVoice {
  return createIdentityAskVoice(identityAskClient);
}
