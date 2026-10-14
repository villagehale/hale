import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE TEXT A PARENT, FOUNDER, CAREGIVER, OR CO-PARENT SEES.
 *
 * A model writes it. There is no fixed sentence and no token to recite. STOP
 * and ARRET stay available as the carrier opt-out on a first text to a stranger.
 *
 * A missing client, a missing skill, a model failure, or a draft that tells
 * them which token to type is unwritten, and the log names which. The caller
 * does not fall back to a keyword sentence.
 */

export type ConsentAsk =
  | { kind: 'founder_ping'; location: string }
  | { kind: 'founder_retry' }
  | { kind: 'partial_failure'; draftCount: number }
  | { kind: 'checkup_drafted' }
  | { kind: 'caregiver_scope'; name: string; role: string }
  | { kind: 'caregiver_invite'; who: string; role: string }
  | { kind: 'caregiver_nudge' }
  | { kind: 'coparent_scope'; name: string; language: ReplyLanguage }
  | { kind: 'coparent_invite'; inviterName: string; language: ReplyLanguage }
  | { kind: 'coparent_nudge'; language: ReplyLanguage }
  | { kind: 'forward_revoke'; language: ReplyLanguage };

export interface ConsentAskWriter {
  write(ask: ConsentAsk): Promise<string | null>;
}

const MAX_SEGMENTS = 2;

export const CONSENT_ASK_MAX_TOKENS = 256;

export const CONSENT_ASK_TOOL = 'consent_ask';

export const consentAskSchema = z.object({
  text: z.string(),
});

export const CONSENT_ASK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
} as const;

/**
 * Hale telling someone which token to type. STOP and ARRET are the carrier
 * opt-out and are not in this pattern.
 */
const KEYWORD_ASK =
  /\b(reply|respond|text|send|type|répondez|repondez)\b[^.?!\n]{0,48}\b(yes|no|oui|non|intro|intros)\b/i;

export function instructsConsentKeyword(text: string): boolean {
  return KEYWORD_ASK.test(text);
}

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function consentAskUserMessage(ask: ConsentAsk): string {
  return JSON.stringify(ask);
}

export function toConsentAskText(raw: { text?: unknown }): string | null {
  if (typeof raw.text !== 'string') return null;
  const text = raw.text.trim();
  if (text.length === 0) return null;
  return text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unwritten(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'consent ask: not sent');
  return null;
}

/** A draft that can go on the wire: no keyword instruction, GSM-7, two segments. */
export function acceptConsentAsk(text: string): string | null {
  if (instructsConsentKeyword(text)) return unwritten('instructs_keyword');
  if (smsEncoding(text) !== 'gsm7') return unwritten('not_gsm7');
  if (smsSegments(text) > MAX_SEGMENTS) return unwritten('over_segment_cap');
  return text;
}

/**
 * `client` is a resolver, not a value. A missing key must not throw. Nothing
 * is sent, and the log names why.
 */
export function createConsentAskWriter(client: () => AgentClient): ConsentAskWriter {
  return {
    async write(ask) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unwritten('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('consent-ask');
      } catch (err) {
        return unwritten('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: consentAskUserMessage(ask),
          toolName: CONSENT_ASK_TOOL,
          toolDescription: 'Write the one text this person will see.',
          inputJsonSchema: CONSENT_ASK_TOOL_SCHEMA,
          schema: consentAskSchema,
          maxTokens: CONSENT_ASK_MAX_TOKENS,
        });
        const text = toConsentAskText(value);
        if (!text) return unwritten('empty');
        return acceptConsentAsk(text);
      } catch (err) {
        return unwritten('model_failed', message(err));
      }
    },
  };
}

/** Absence is named. A null return means nothing was sent. */
export async function writeConsentAsk(
  writer: ConsentAskWriter | undefined,
  ask: ConsentAsk,
): Promise<string | null> {
  if (!writer) return unwritten('not_configured', ask.kind);
  return writer.write(ask);
}
