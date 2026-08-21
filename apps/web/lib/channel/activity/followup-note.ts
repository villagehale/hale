import { type AgentClient, pickModel } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { modelIsUnreachable } from '~/lib/channel/router/smoke-alarm';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { ActivityPick } from './lane';

/**
 * THE KEPT PROMISE, IN WORDS — the one text the activity follow-up sweep sends.
 *
 * Composed, never a template, for the reason the plan check-in is: a preset body is a
 * sentence nobody is writing for THIS family, and this is the message with the most to
 * gain from being written for them — it knows what they asked and what turned up. A gate
 * refusal is fed back and recomposed; exhausting the attempts leaves the promise OPEN for
 * the next tick rather than sending something canned.
 *
 * TWO SHAPES, one composer, because they are one message with different contents:
 *
 *   FOUND — up to three real picks, each read off somebody's own page. The top one leads,
 *   and {@link topPickLeads} makes that a GATE rather than a preference. See below.
 *
 *   EMPTY — the search ran and there is nothing. This is the half that had to exist before
 *   the promise could be made honestly: "I'll come back to you" is only true if Hale comes
 *   back when the answer is bad news, and a sweep that texts only on success is a sweep
 *   that silently drops every disappointing promise (rule #11 — the absence of the effect
 *   is a first-class outcome, and here it is an outcome the PARENT is told about).
 *
 * THE TOP PICK LANDS IN SEGMENT ONE, as a gate. A carrier bills 153 GSM-7 characters a
 * part and a phone shows the first of them; every trim in this codebase drops from the end
 * (coach/reply.ts `fitToBudget`). So an answer whose best find is in the last sentence is
 * an answer whose best find is the first thing to disappear — which is the shape of the
 * "later answers trimmed off the end" defect this product already has a name for.
 * Requiring the name in the first segment costs the model nothing and cannot be lost.
 *
 * NEVER CLAIMS WHAT IT DID NOT DO. Every pick here came off the WEB, and
 * {@link claimsVerification} refuses a body that says otherwise. It is deliberately narrow
 * in one direction: "I'll confirm before you book" is exactly what Hale SHOULD say, so a
 * future-tense promise to check is not a claim to have checked. The failure this gate
 * exists to prevent runs the other way — Hale telling a parent a time is confirmed when
 * all it has is a page that said so.
 *
 * AND IT NEVER GOES QUIET INSTEAD. There is no violation here for "unverified". A find
 * that is only as good as its source is still a find, and withholding it is the silence
 * that started all this.
 */

/** One SMS, two segments — the same ceiling every other unprompted message keeps. */
export const MAX_FOLLOWUP_SEGMENTS = 2;

/** GSM-7 characters in one segment. The budget the top pick has to land inside. */
const FIRST_SEGMENT_CHARS = 153;

/** Same reasoning as the plan note's: a model that cannot fix a named mechanical fault in
 * three tries will not fix it on the fourth. */
export const MAX_FOLLOWUP_ATTEMPTS = 3;

const MAX_TOKENS = 400;

const LINK_SHAPE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ca|org|net|io|co|tv)\b/i;

export type FollowUpFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_unreachable'
  | 'model_failed'
  | 'gates_exhausted';

export type FollowUpComposeOutcome =
  | { status: 'composed'; message: string }
  | { status: 'deferred'; reason: FollowUpFallback; violations: readonly string[] };

export interface FollowUpGrounding {
  /** The de-identified subject the promise was about, off the ledger row. */
  subject: string;
  /** What the re-run search found. EMPTY is a valid, sendable grounding — see the module
   * note on why the bad-news half is the half that makes the promise honest. */
  picks: readonly ActivityPick[];
}

export interface FollowUpComposer {
  compose(grounding: FollowUpGrounding): Promise<FollowUpComposeOutcome>;
}

const noteSchema = z.object({ message: z.string() });

const noteJsonSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
} as const;

/** Shared with the eval, which REPLICATES this request shape. It carries the picks and the
 * subject and nothing else — no family, no child, no thread (rule #1). */
export function followUpUserMessage(grounding: FollowUpGrounding): string {
  return JSON.stringify({
    mode: 'followup_text',
    subject: grounding.subject,
    picks: grounding.picks.map((pick) => ({
      name: pick.name,
      age_fit: pick.ageFit,
      when: pick.when,
      price: pick.price,
      source_name: pick.sourceName,
      source: pick.source,
    })),
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/**
 * Whether the best find survives a phone's first screen — and therefore any trim.
 *
 * Matched on the pick's NAME rather than on sentence order, because "the top pick leads"
 * is about what a parent SEES, and a body that opens with a clause of preamble and then
 * names the place is fine. What is not fine is the name arriving in segment two.
 */
export function topPickLeads(body: string, picks: readonly ActivityPick[]): boolean {
  const top = picks[0];
  if (!top) return true;
  return body.slice(0, FIRST_SEGMENT_CHARS).toLowerCase().includes(top.name.toLowerCase());
}

/**
 * Whether the body claims Hale VERIFIED something it only read.
 *
 * Clause-scoped with a qualifier guard, the shape `hasEmergencyDirective` uses in the
 * medical lane and for the same reason: every phrase that makes an honest future promise
 * ("I'll confirm the time before you book") contains the very word that makes a dishonest
 * past claim, so a whole-body match would refuse the sentence Hale is supposed to write.
 * A clause carrying the word and NO qualifier is the claim.
 */
const CLAUSE_BOUNDARY = /[.!?;:,\n]|\s-\s/;
const VERIFICATION_CLAIM = /\b(?:confirmed|verified|double-?checked|vetted)\b/i;
const FUTURE_OR_NEGATED =
  /\bi'?ll\b|\bi will\b|\bwe'?ll\b|\bwe will\b|\bgoing to\b|\bcan\b|\bto (?:confirm|verify|double-?check)\b|\bbefore\b|\bonce\b|\bafter\b|\byet\b|\bnot\b|\bn'?t\b|\bunconfirmed\b/i;

export function claimsVerification(body: string): boolean {
  return body
    .split(CLAUSE_BOUNDARY)
    .some((clause) => VERIFICATION_CLAIM.test(clause) && !FUTURE_OR_NEGATED.test(clause));
}

/**
 * Everything wrong with this follow-up, phrased for the model that will rewrite it. An
 * empty array means it may be sent.
 */
export function followUpViolations(body: string, grounding: FollowUpGrounding): string[] {
  const violations: string[] = [];
  const text = plainText(body);

  if (text === '') return ['The message was empty.'];
  if (smsSegments(text) > MAX_FOLLOWUP_SEGMENTS) {
    violations.push(
      `The message is ${smsSegments(text)} SMS segments; it must be at most ${MAX_FOLLOWUP_SEGMENTS}. Cut it to about 300 characters.`,
    );
  }
  if (smsEncoding(text) !== 'gsm7') {
    violations.push(
      'The message contains a character that doubles the cost to send (a curly quote, a dash, or an emoji). Use plain ASCII.',
    );
  }
  if (LINK_SHAPE.test(text)) {
    violations.push('The message contains a link or a web address. Never send one.');
  }
  if (claimsVerification(text)) {
    violations.push(
      'The message says these details are confirmed or verified. They are not - they came off the venue\'s own page. Say whose page it was ("their site says...") and offer to confirm before they book.',
    );
  }
  if (!topPickLeads(text, grounding.picks)) {
    const top = grounding.picks[0];
    violations.push(
      `The best find (${top?.name}) is not named in the first ${FIRST_SEGMENT_CHARS} characters, so it is the first thing a trim would cut. Lead with it.`,
    );
  }
  return violations;
}

export function createFollowUpComposer(client: () => AgentClient): FollowUpComposer {
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
        skill = await loadCronSkill('activity-finder');
      } catch (err) {
        return deferred('skill_unavailable', [message(err)]);
      }

      let violations: string[] = [];
      for (let attempt = 1; attempt <= MAX_FOLLOWUP_ATTEMPTS; attempt += 1) {
        let value: z.infer<typeof noteSchema>;
        try {
          const result = await forceToolJson({
            client: resolved,
            model: pickModel(skill.meta.task),
            system: skill.instructions,
            userMessage: retryFollowUpMessage(followUpUserMessage(grounding), violations),
            toolName: 'followup_text',
            toolDescription: 'Return the one message to send this parent.',
            inputJsonSchema: noteJsonSchema,
            schema: noteSchema,
            maxTokens: MAX_TOKENS,
          });
          value = result.value;
        } catch (err) {
          if (modelIsUnreachable(err)) return deferred('model_unreachable', [message(err)]);
          return deferred('model_failed', [message(err)]);
        }

        violations = followUpViolations(value.message, grounding);
        if (violations.length === 0) {
          return { status: 'composed', message: plainText(value.message) };
        }
        console.error(
          { attempt, picks: grounding.picks.length, violations: violations.length },
          'activity follow-up: refused by the gates, recomposing',
        );
      }
      return deferred('gates_exhausted', violations);
    },
  };
}

function deferred(reason: FollowUpFallback, violations: readonly string[]): FollowUpComposeOutcome {
  console.error(
    { reason, violations },
    'activity follow-up: deferring rather than sending a canned line',
  );
  return { status: 'deferred', reason, violations };
}

export function retryFollowUpMessage(base: string, violations: readonly string[]): string {
  if (violations.length === 0) return base;
  return JSON.stringify({
    ...(JSON.parse(base) as Record<string, unknown>),
    rejectedLastAttempt: violations,
  });
}
