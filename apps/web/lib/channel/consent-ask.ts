import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { joinDoorModelCopyEnabled } from '~/lib/channel/door-line';
import type { ReplyLanguage } from '~/lib/channel/language';
import { namesOptOutKeyword } from '~/lib/channel/opt-out';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE TEXT A PARENT, FOUNDER, CAREGIVER, OR CO-PARENT SEES.
 *
 * A model writes it. There is no fixed sentence and no token to recite.
 *
 * VIL-706: dark, the skill still lets a first text to a stranger (and a nudge to one)
 * name STOP or ARRET as the carrier opt-out. With JOIN_DOOR_MODEL_COPY_ENABLED lit, those
 * four kinds carry the `consent-ask-no-keyword` addendum and a draft that names an
 * opt-out keyword is unwritten: the stranger is told, in plain words, that they can say
 * they would rather not hear from Hale. Every other kind keeps its bytes either way.
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
  | { kind: 'coparent_scope'; name: string; language: ReplyLanguage | null }
  | { kind: 'coparent_invite'; inviterName: string; language: ReplyLanguage | null }
  | { kind: 'coparent_nudge'; language: ReplyLanguage | null }
  | { kind: 'forward_revoke'; language: ReplyLanguage | null };

export interface ConsentAskWriter {
  write(ask: ConsentAsk): Promise<string | null>;
}

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

/** The first text to a stranger and a nudge to that stranger: the kinds the skill lets
 * name STOP or ARRET while dark. */
const STRANGER_KINDS: ReadonlySet<ConsentAsk['kind']> = new Set([
  'caregiver_invite',
  'caregiver_nudge',
  'coparent_invite',
  'coparent_nudge',
]);

/**
 * VIL-706 · whether this ask is written without any opt-out keyword: one of the four
 * stranger kinds, with JOIN_DOOR_MODEL_COPY_ENABLED lit. Shared with the eval.
 */
export function consentAskKeywordless(ask: ConsentAsk): boolean {
  return STRANGER_KINDS.has(ask.kind) && joinDoorModelCopyEnabled();
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

/**
 * A draft that can go on the wire: no keyword instruction. Length is not a hold. With
 * `refuseOptOutKeyword` (a keywordless ask, VIL-706), a draft that names STOP, ARRET,
 * HELP or AIDE as a keyword is not one either.
 */
export function acceptConsentAsk(
  text: string,
  options: { refuseOptOutKeyword?: boolean } = {},
): string | null {
  if (instructsConsentKeyword(text)) return unwritten('instructs_keyword');
  if (options.refuseOptOutKeyword && namesOptOutKeyword(text) !== null) {
    return unwritten('names_opt_out_keyword');
  }
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

      const keywordless = consentAskKeywordless(ask);
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      let extras: string[];
      try {
        skill = await loadCronSkill('consent-ask');
        // A system extra, after the cache breakpoint: dark, the request keeps its bytes.
        extras = keywordless ? [(await loadCronSkill('consent-ask-no-keyword')).instructions] : [];
      } catch (err) {
        return unwritten('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          ...(extras.length > 0 ? { systemExtras: extras } : {}),
          userMessage: consentAskUserMessage(ask),
          toolName: CONSENT_ASK_TOOL,
          toolDescription: 'Write the one text this person will see.',
          inputJsonSchema: CONSENT_ASK_TOOL_SCHEMA,
          schema: consentAskSchema,
          maxTokens: CONSENT_ASK_MAX_TOKENS,
        });
        const text = toConsentAskText(value);
        if (!text) return unwritten('empty');
        return acceptConsentAsk(text, { refuseOptOutKeyword: keywordless });
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
