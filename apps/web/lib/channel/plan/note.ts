import { type AgentClient, pickLane } from '@hale/agent';
import type { CoachingPlaybook } from '@hale/types';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { modelIsUnreachable } from '~/lib/channel/router/smoke-alarm';
import { reachesForTheHealthLine } from '~/lib/channel/off-domain/copy';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { PlanTopic } from './topics';

/**
 * THE ONE-LINE NOTES — the two short messages the plan arc sends that are not the plan.
 *
 * Both are composed, neither has a preset body, and they share this module because they
 * share a SHAPE rather than a subject: one message, gated, rewritten on refusal,
 * deferred rather than faked. Keeping them together is what stops the second one being
 * written as a constant "because it is only one sentence" — which is exactly how the
 * seven fixed check-in lines got written the first time.
 *
 *   TOO_YOUNG — the parent said yes, and the child is outside the method's age gate. It
 *   is a refusal, so it is the higher-stakes of the two: it must say what the gate is,
 *   why, and what to do instead, grounded on the playbook's own verified words.
 *
 *   CHECK_IN — the promise the plan made, kept. One warm question about the plan they
 *   started, on the day Hale said.
 *
 * NO FIXED FALLBACK, on either. A gate refusal is fed back and recomposed; exhausting
 * the attempts or finding the provider unreachable DEFERS, and the caller decides
 * whether that means a job retry (the YES path) or the next sweep tick (the check-in).
 */

/** One SMS. Both notes are one message by design: a refusal that runs long reads as an
 * excuse, and a check-in that runs long is a lecture nobody asked for. */
export const MAX_NOTE_SEGMENTS = 2;

/** Same reasoning as the plan's: a model that cannot fix a named mechanical fault in
 * three tries will not fix it on the fourth. */
export const MAX_NOTE_ATTEMPTS = 3;

const MAX_TOKENS = 400;

const LINK_SHAPE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ca|org|net|io|co|tv)\b/i;

export type NoteKind = 'too_young' | 'check_in';

export type NoteFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_unreachable'
  | 'model_failed'
  | 'gates_exhausted';

export type NoteComposeOutcome =
  | { status: 'composed'; message: string }
  | { status: 'deferred'; reason: NoteFallback; violations: readonly string[] };

export interface NoteGrounding {
  kind: NoteKind;
  topic: PlanTopic;
  playbook: CoachingPlaybook;
  /** The child's age, when one is known. Load-bearing for `too_young` — it is the whole
   * reason that message exists — and useful context for a check-in. */
  child: { ageMonths: number } | null;
  /** `too_young` only: the parent's own question, so the refusal answers THEIR ask. */
  question: string | null;
  /** `check_in` only: the promise being kept — the method name and the day Hale said. */
  promise: { summary: string; promisedDay: string } | null;
}

export interface NoteComposer {
  compose(grounding: NoteGrounding): Promise<NoteComposeOutcome>;
}

const noteSchema = z.object({ message: z.string() });

const noteJsonSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
} as const;

/** Shared with the eval, which REPLICATES this request shape. The playbook is projected
 * down to the parts each note needs: a refusal needs the gate and the triggers, a
 * check-in needs neither and must not be tempted to re-teach the method. */
export function noteUserMessage(grounding: NoteGrounding): string {
  const shared = { kind: grounding.kind, topic: grounding.topic, child: grounding.child };
  if (grounding.kind === 'too_young') {
    return JSON.stringify({
      ...shared,
      question: grounding.question,
      method: grounding.playbook.primaryMethod.name,
      ageGate: grounding.playbook.primaryMethod.ageGate,
      doctorTriggers: grounding.playbook.doctorTriggers,
      readinessSigns: grounding.playbook.readinessSigns,
    });
  }
  return JSON.stringify({ ...shared, promise: grounding.promise });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/**
 * Everything wrong with this note, phrased for the model that will rewrite it.
 *
 * The one-question rule is a hard gate on both kinds and not a style note: a check-in
 * asking two things is a message a walking parent answers with silence, and a refusal
 * that ends with a second question buries the part that mattered.
 */
export function noteViolations(body: string, grounding: NoteGrounding): string[] {
  const violations: string[] = [];
  const text = plainText(body);

  if (text === '') {
    violations.push('The message was empty.');
    return violations;
  }
  if (smsSegments(text) > MAX_NOTE_SEGMENTS) {
    violations.push(
      `The message is ${smsSegments(text)} SMS segments; it must be at most ${MAX_NOTE_SEGMENTS}. Cut it to about 300 characters.`,
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

  const questions = (text.match(/\?/g) ?? []).length;
  if (grounding.kind === 'check_in') {
    if (questions !== 1) {
      violations.push(
        `The check-in asks ${questions} questions; it must ask exactly one, and end on it.`,
      );
    }
    const method = grounding.playbook.primaryMethod.name.toLowerCase();
    if (text.toLowerCase().includes(method.split('(')[0]?.trim() ?? method)) {
      // Re-teaching is the failure mode here. They have the plan; this asks how it went.
      violations.push(
        'The check-in re-states the method. They already have the plan - just ask how it has gone.',
      );
    }
    if (reachesForTheHealthLine(text)) {
      violations.push(
        'The check-in gives a phone number. It is a friendly question about how a plan went, not a referral.',
      );
    }
  } else {
    if (questions > 1) {
      violations.push(`The message asks ${questions} questions; ask at most one.`);
    }
    if (reachesForTheHealthLine(text)) {
      violations.push(
        'The message gives a phone number. Name the situation worth raising with their doctor instead, with no number.',
      );
    }
  }
  return violations;
}

export function createNoteComposer(client: () => AgentClient): NoteComposer {
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
        skill = await loadCronSkill('coach-plan-note');
      } catch (err) {
        return deferred('skill_unavailable', [message(err)]);
      }

      let violations: string[] = [];
      for (let attempt = 1; attempt <= MAX_NOTE_ATTEMPTS; attempt += 1) {
        let value: z.infer<typeof noteSchema>;
        try {
          const result = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: retryNoteMessage(noteUserMessage(grounding), violations),
            toolName: 'note',
            toolDescription: 'Return the one message to send.',
            inputJsonSchema: noteJsonSchema,
            schema: noteSchema,
            maxTokens: MAX_TOKENS,
          });
          value = result.value;
        } catch (err) {
          if (modelIsUnreachable(err)) return deferred('model_unreachable', [message(err)]);
          return deferred('model_failed', [message(err)]);
        }

        violations = noteViolations(value.message, grounding);
        if (violations.length === 0) {
          return { status: 'composed', message: plainText(value.message) };
        }
        console.error(
          { attempt, kind: grounding.kind, violations: violations.length },
          'coach plan note: refused by the gates, recomposing',
        );
      }
      return deferred('gates_exhausted', violations);
    },
  };
}

function deferred(reason: NoteFallback, violations: readonly string[]): NoteComposeOutcome {
  console.error({ reason, violations }, 'coach plan note: deferring rather than sending a canned line');
  return { status: 'deferred', reason, violations };
}

export function retryNoteMessage(base: string, violations: readonly string[]): string {
  if (violations.length === 0) return base;
  return JSON.stringify({
    ...(JSON.parse(base) as Record<string, unknown>),
    rejectedLastAttempt: violations,
  });
}
