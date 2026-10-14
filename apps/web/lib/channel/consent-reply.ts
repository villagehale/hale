import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * WHETHER A REPLY AGREES, REFUSES, OR DOES NEITHER.
 *
 * A model reads the reply. There is no word list and no fixed sentence. The
 * question comes from the caller, never from a keyword the parent was taught.
 *
 * A missing client, a missing skill, or a model failure is unreadable, and the
 * log names which. The parent's text is never in that line. The caller treats
 * unreadable the same as neither: it does not assent, revoke, grant, or text
 * a stranger.
 */

export type ConsentQuestion =
  | 'founder_welcome'
  | 'caregiver_scope'
  | 'caregiver_invite'
  | 'coparent_scope'
  | 'coparent_invite'
  | 'forward_revoke'
  | 'intro';

export type ConsentTarget = 'discoverability' | 'proposal' | 'none';

export interface ConsentReadingResult {
  verdict: 'yes' | 'no' | 'neither';
  target: ConsentTarget;
}

export interface ConsentReader {
  read(input: { question: ConsentQuestion; text: string }): Promise<ConsentReadingResult | null>;
}

const MAX_TEXT_CHARS = 1600;

export const CONSENT_REPLY_MAX_TOKENS = 256;

export const CONSENT_REPLY_TOOL = 'consent_reply';

const VERDICTS = ['yes', 'no', 'neither'] as const;
const TARGETS = ['discoverability', 'proposal', 'none'] as const;

export const consentReplySchema = z.object({
  verdict: z.enum(VERDICTS),
  target: z.enum(TARGETS),
  reason: z.string().optional(),
});

export const CONSENT_REPLY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    target: { type: 'string', enum: [...TARGETS] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'target'],
} as const;

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function consentReplyUserMessage(input: {
  question: ConsentQuestion;
  text: string;
}): string {
  return JSON.stringify({ question: input.question, text: input.text });
}

export function toConsentReading(raw: {
  verdict?: unknown;
  target?: unknown;
}): ConsentReadingResult | null {
  if (raw.verdict !== 'yes' && raw.verdict !== 'no' && raw.verdict !== 'neither') return null;
  if (raw.target !== 'discoverability' && raw.target !== 'proposal' && raw.target !== 'none') {
    return null;
  }
  return { verdict: raw.verdict, target: raw.target };
}

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unreadable(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'consent reply: unreadable');
  return null;
}

/**
 * `client` is a resolver, not a value. A missing key must not throw. It is
 * unreadable, named in the log, and the caller does not act.
 */
export function createConsentReader(client: () => AgentClient): ConsentReader {
  return {
    async read(input) {
      const bounded = input.text.slice(0, MAX_TEXT_CHARS);
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unreadable('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('consent-reply');
      } catch (err) {
        return unreadable('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: consentReplyUserMessage({ question: input.question, text: bounded }),
          toolName: CONSENT_REPLY_TOOL,
          toolDescription: 'Decide whether this message agrees, refuses, or does neither.',
          inputJsonSchema: CONSENT_REPLY_TOOL_SCHEMA,
          schema: consentReplySchema,
          maxTokens: CONSENT_REPLY_MAX_TOKENS,
        });
        const reading = toConsentReading(value);
        if (!reading) return unreadable('unreadable');
        return reading;
      } catch (err) {
        return unreadable('model_failed', message(err));
      }
    },
  };
}

/** Absence is named. The caller treats null as neither and does not act. */
export async function readConsent(
  reader: ConsentReader | undefined,
  input: { question: ConsentQuestion; text: string },
): Promise<ConsentReadingResult | null> {
  if (!reader) {
    console.info(
      { reason: 'not_configured', question: input.question },
      'consent reply: unreadable',
    );
    return null;
  }
  return reader.read(input);
}
