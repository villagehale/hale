import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import type { EmailAlertPassportFacts } from '~/lib/passport/ingest';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { ExtractionKind } from '~/lib/sentinel';

/**
 * The email alert text. The model writes the WHOLE message from facts, in the parent's
 * language: no code-built sentence, no fixed title, no appended question. Code owns the
 * facts (teen mail already reduced to a category, sender folded to a display name or
 * domain, never a line of the email) and whether a question MAY be asked, because a
 * question needs a row behind it. The model owns every word and the shape.
 *
 * A text that cannot be written is NOTHING SENT: there is no fallback copy.
 */

export const EMAIL_ALERT_SKILL = 'email-alert';

export type EmailAlertAsk = 'add_to_week' | 'calendar';

export interface EmailAlertFacts {
  kind: ExtractionKind;
  /** Display name or bare domain; null for category-only mail or none. */
  from: string | null;
  /** The email's own name for the thing, folded; null when none survives. */
  what: string | null;
  when: { was: string | null; now: string | null };
  where: string | null;
  categoryOnly: boolean;
  fromCalendar: boolean;
  /** Other Hale families holding this session, or null when nothing may be said. */
  going: number | null;
  /** The one question the text may end with, or null. Code decides; the model words it. */
  ask: EmailAlertAsk | null;
  language: ReplyLanguage;
  /** Interest passport facts (flag on, a receipt Hale will keep on the child's record), or
   * null. The model says it inside the text; code adds no line for it. */
  passport: EmailAlertPassportFacts | null;
}

/** The user turn. Shared with the eval, which replays this request shape. */
export function emailAlertUserMessage(facts: EmailAlertFacts): string {
  return JSON.stringify(facts);
}

export const EMAIL_ALERT_MAX_CHARS = 480;
const URL_SHAPE = /https?:\/\/\S+/i;
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Structural refusals only, never wording. */
export function emailAlertRefusals(body: string, facts: EmailAlertFacts): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  const found: string[] = [];
  if (text.length > EMAIL_ALERT_MAX_CHARS) found.push('over_char_cap');
  if (URL_SHAPE.test(text)) found.push('link');
  if (EMAIL_SHAPE.test(text)) found.push('email_address');
  // A question with no row behind it is consent read against nothing (#649).
  if (facts.ask === null && /[?？¿]/.test(text)) found.push('unbacked_question');
  return found;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const EMAIL_ALERT_MAX_ATTEMPTS = 2;

/**
 * The whole alert, or null after two refused or failed attempts. Null sends nothing.
 *
 * LOGS CARRY NO EMAIL CONTENT: family id, attempt, refusal names and the error CLASS
 * only. A model rejection or a draft can quote the title or the sender (rule #1).
 */
export async function composeEmailAlertText(
  client: AgentClient,
  facts: EmailAlertFacts,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(EMAIL_ALERT_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'email alert: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= EMAIL_ALERT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: emailAlertUserMessage(facts),
        toolName: 'email_alert_text',
        toolDescription: 'The one text Hale sends the parent about this email.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: 300,
      });
      const text = value.text.trim();
      const refusals = emailAlertRefusals(text, facts);
      if (refusals.length === 0) return text;
      console.warn({ familyId, attempt, refusals }, 'email alert: draft refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'email alert: compose failed',
      );
    }
  }
  console.error({ familyId, outcome: 'email_alert_unwritten' }, 'email alert: nothing sent');
  return null;
}
