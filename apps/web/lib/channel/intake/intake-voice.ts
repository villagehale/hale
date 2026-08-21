import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadIntakeVoiceSkill } from '~/lib/cron/skill';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { forceToolJson } from '~/lib/pipeline/structured';
import { type IntakeGap, followUp, followUpQuestion } from './copy';
import type { ExtractedChild } from './extract';

/**
 * The intake ACKNOWLEDGMENT turn, said in Hale's voice.
 *
 * copy.ts is the spec for what Hale DECIDES and every compliance string it must say
 * exactly; this is the one intake turn where the WORDS are the product. The follow-up is
 * where a parent finds out whether they are talking to something that reads or something
 * that parses, and "Got it - Maya (4) and Leo (1)." is a receipt, not a reply.
 *
 * The split is the same one the radar uses (DECIDE / COMPOSE), for the same reason: the
 * model writes only the acknowledgment half, and the QUESTION — the part with a job to
 * do — is appended deterministically by {@link followUpQuestion}. So the worst a bad
 * composition can cost is warmth. It can never cost the ask.
 *
 * Four checks before composed words are allowed out, each with a failure it exists to
 * stop:
 *
 *   1. the fact lint (a time or link the parent never mentioned);
 *   2. the question gate (the shell appends the only question this turn gets);
 *   3. the GSM-7 gate (one curly apostrophe doubles what every intake costs to send);
 *   4. the budget (the ack plus the appended question is still one text message).
 *
 * Rule #11: the fallback is NEVER silent. Every degraded path logs and comes back NAMED
 * in {@link IntakeAck.fallback}, so "the model was skipped" and "the model was wrong" are
 * different, countable outcomes rather than the same quiet template.
 */

const MAX_TOKENS = 200;

/**
 * The ceiling for the composed half: this is the front of a text that still has a
 * question to fit after it.
 *
 * There is deliberately no separate segment check. The longest question the shell can
 * append is 58 septets, so 160 + 58 is 218 — inside two segments by construction, and
 * the intake-voice test pins that arithmetic. A second budget guard here would be a
 * branch no input can reach, and an unreachable guard is worse than none: it reads like
 * protection nobody has ever exercised.
 */
export const MAX_ACK_CHARS = 160;

/**
 * Why a turn went out on the template instead of composed words. Each value is a
 * different operational story: `voice_unavailable` is configuration, `skill_unavailable`
 * is a deploy bug, `model_failed` is an outage, `unusable` is the model getting it wrong
 * and the guards catching it. Folding them into one bucket would hide exactly the one
 * that needs a human.
 */
export type IntakeAckFallback =
  | 'voice_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable';

export interface IntakeAck {
  /** The complete message body to send — composed or template, always whole. */
  body: string;
  source: 'composed' | 'template';
  /** Null exactly when {@link source} is `'composed'`. */
  fallback: IntakeAckFallback | null;
}

export interface IntakeAckInput {
  /** The parent's own words this turn — the material the acknowledgment is written from. */
  parentWords: string;
  /** The deterministic echo of the children extracted so far. */
  summary: string;
  /** The extracted children: the ONLY child facts the model may state. */
  children: readonly ExtractedChild[];
  /** The QR venue the parent arrived through, or null (then Hale does not know one). */
  venue: string | null;
  /** What is still outstanding. Context for the model, and the question the shell asks. */
  missing: readonly IntakeGap[];
}

export interface IntakeAckComposer {
  compose(input: IntakeAckInput): Promise<IntakeAck>;
}

const ackSchema = z.object({ ack: z.string() }).strict();

const ackJsonSchema = {
  type: 'object',
  properties: { ack: { type: 'string' } },
  required: ['ack'],
} as const;

/**
 * What the model is handed: the parent's words and the extracted facts, nothing else. No
 * family id, no postal code, no session state — an acknowledgment has no use for any of
 * them, and rule #1 says the model sees only what the message may contain.
 */
export function intakeAckContext(input: IntakeAckInput): unknown {
  return {
    parentWords: input.parentWords,
    summary: input.summary,
    children: input.children.map((child) => ({ name: child.name, ageMonths: child.ageMonths })),
    venue: input.venue,
    missing: input.missing,
  };
}

/** Every fact the acknowledgment may reuse, for the invented-fact lint. */
export function intakeAckFactSlots(input: IntakeAckInput): string[] {
  const slots = [input.parentWords, input.summary];
  for (const child of input.children) {
    if (child.name) slots.push(child.name);
    if (child.ageMonths !== null) slots.push(String(child.ageMonths));
  }
  if (input.venue) slots.push(input.venue);
  return slots;
}

/**
 * Whether a composed acknowledgment may be sent: grounded, question-free, GSM-7, inside
 * the character ceiling, and still one text once the question is appended.
 */
export function usableAck(ack: string, input: IntakeAckInput): boolean {
  const trimmed = ack.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACK_CHARS) return false;
  if (trimmed.includes('?')) return false;
  if (smsEncoding(trimmed) !== 'gsm7') return false;
  return findInventedFacts(trimmed, intakeAckFactSlots(input)).length === 0;
}

/** The composed half plus the deterministic ask — the only way the two are joined. */
function ackBody(ack: string, missing: readonly IntakeGap[]): string {
  return `${ack.trim()} ${followUpQuestion(missing)}`;
}

/** The template outcome, logged and named. The body is byte-identical to what intake
 * sent before this stage existed, so a degraded turn is a normal turn. */
function template(input: IntakeAckInput, fallback: IntakeAckFallback): IntakeAck {
  console.error({ fallback, missing: input.missing }, 'intake-voice: template acknowledgment');
  return { body: followUp(input.summary, input.missing), source: 'template', fallback };
}

/**
 * The production composer. A null client — no API key, or the voice kill switch — is a
 * first-class outcome, not an error: a parent mid-intake gets their question whether or
 * not a model is reachable.
 */
export function createIntakeAckComposer(client: AgentClient | null): IntakeAckComposer {
  return {
    async compose(input) {
      if (!client) return template(input, 'voice_unavailable');

      // Loaded INSIDE the fallback boundary, unlike the loop's voice callers: this sits
      // in the middle of a stranger's first conversation, and no deploy problem is worth
      // leaving that conversation unanswered.
      let skill: Awaited<ReturnType<typeof loadIntakeVoiceSkill>>;
      try {
        skill = await loadIntakeVoiceSkill();
      } catch (err) {
        console.error({ err }, 'intake-voice: skill load failed');
        return template(input, 'skill_unavailable');
      }

      let ack: string;
      try {
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: JSON.stringify(intakeAckContext(input)),
          toolName: 'ack',
          toolDescription: 'Return the acknowledgment sentence.',
          inputJsonSchema: ackJsonSchema,
          schema: ackSchema,
          maxTokens: MAX_TOKENS,
        });
        ack = value.ack;
      } catch (err) {
        console.error({ err }, 'intake-voice: compose call failed');
        return template(input, 'model_failed');
      }

      if (!usableAck(ack, input)) return template(input, 'unusable');
      return { body: ackBody(ack, input.missing), source: 'composed', fallback: null };
    },
  };
}
