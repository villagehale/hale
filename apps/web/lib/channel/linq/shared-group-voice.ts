import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject, voiceClient } from '~/lib/loop/voice/compose';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type SharedGroupLine,
  type SharedGroupThreadLine,
  type SharedGroupVoiceKind,
  type SharedGroupVoiceRequest,
  sharedGroupFactStrings,
  sharedGroupLineInput,
} from './shared-group-line-input';

/**
 * VIL-456 — the model writes one shared-group line from facts.
 *
 * No fixed parent copy. A line the model could not write is retried once, then
 * nothing is sent: audit `group_line_unsent`, page #ops. There is no fallback
 * sentence.
 */

export type SharedGroupLineSource = 'composed' | 'retry';

export type SharedGroupLineFallback =
  | 'voice_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable'
  | 'declined';

export interface SpokenSharedLine {
  send: boolean;
  line?: string;
  why?: string;
}

export interface SharedGroupComposer {
  compose(
    input: SharedGroupLine,
    options?: { prompt?: 'full' | 'short' },
  ): Promise<SpokenSharedLine>;
}

const spokenSchema = z
  .object({
    send: z.boolean(),
    line: z.string().optional(),
    before: z.string().optional(),
    question: z.string().optional(),
    why: z.string().optional(),
  })
  .strict();

function parseSpoken(answer: string | null, questions: 0 | 1): SpokenSharedLine | null {
  if (!answer) return null;
  const raw = firstJsonObject(answer);
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return acceptSpoken(value, questions);
}

export function acceptSpoken(value: unknown, questions: 0 | 1): SpokenSharedLine | null {
  const parsed = spokenSchema.safeParse(value);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.send === false) {
    return { send: false, why: record.why?.trim() || 'declined' };
  }
  if (questions === 1) {
    const question = record.question?.trim();
    if (!question) return null;
    const before = record.before?.trim() ?? '';
    return { send: true, line: [before, question].filter(Boolean).join(' ') };
  }
  const line = record.line?.trim();
  if (!line) return null;
  return { send: true, line };
}

const BANNED =
  /\b(www\.|unsubscribe|yes\/no|reply yes|reply no|imessage|assistant|automation|tapback)\b/i;

export function sharedLineUsable(
  line: string,
  input: SharedGroupLine,
  deny: readonly string[] = [],
): boolean {
  const text = line.trim();
  if (!text) return false;
  if (text.length > input.maxChars) return false;
  if (/https?:\/\//i.test(text)) return false;
  if (/\+\d[\d\s-]{7,}/.test(text)) return false;
  const questions = (text.match(/\?/g) ?? []).length;
  if (input.questions === 1 && questions !== 1) return false;
  if (input.questions === 0 && questions !== 0) return false;
  if (text.includes('TODO-Design')) return false;
  if (BANNED.test(text) && !input.wayOut) return false;
  if (input.wayOut && /https?:\/\//i.test(text)) return false;
  const folded = text.toLowerCase();
  for (const token of deny) {
    const needle = token.trim();
    if (needle.length >= 3 && folded.includes(needle.toLowerCase())) return false;
  }
  return true;
}

async function pageUnsent(kind: SharedGroupVoiceKind, fallback: SharedGroupLineFallback) {
  const outcome = await postOpsSlack(
    `Hale shared group: a ${kind} line was not sent (${fallback}). Nothing went to the parent.`,
  );
  console.warn({ kind, fallback, page: outcome }, 'linq shared group: line not sent');
}

function productionComposer(
  scope: { familyId: string; database: Database } | undefined,
): SharedGroupComposer | undefined {
  if (!process.env.ANTHROPIC_API_KEY || process.env.VOICE_DISABLED === 'true') return undefined;
  return {
    async compose(input, options) {
      const skill = await loadCronSkill('shared-group-voice');
      const client = voiceClient() ?? budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
      if (scope) {
        const composed = await composeVoice({
          skill,
          context: { ...input, retry: options?.prompt === 'short' },
          factSlots: sharedGroupFactStrings(input),
          parse: (answer) => {
            const spoken = parseSpoken(answer, input.questions);
            if (!spoken?.send || !spoken.line) return null;
            return { line: spoken.line };
          },
          voiceStrings: (voice) => [voice.line],
          client,
          database: scope.database,
          familyId: scope.familyId,
          agentName: 'reply-copy',
          traceName: 'reply-copy',
          maxTokens: options?.prompt === 'short' ? 160 : 400,
        });
        if (!composed.voice) throw new Error(composed.reason ?? 'unusable');
        return { send: true, line: composed.voice.line };
      }
      const lane = pickLane(skill.meta.task);
      const userMessage = JSON.stringify({ ...input, retry: options?.prompt === 'short' });
      const maxTokens = options?.prompt === 'short' ? 160 : 400;
      const result = await forceToolJson({
        client,
        lane,
        system: skill.instructions,
        userMessage,
        toolName: 'send_shared_group_line',
        toolDescription: 'The one message Hale sends, or a decision to stay quiet.',
        inputJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            send: { type: 'boolean' },
            line: { type: 'string' },
            before: { type: 'string' },
            question: { type: 'string' },
            why: { type: 'string' },
          },
          required: ['send'],
        },
        schema: spokenSchema,
        maxTokens,
      });
      const spoken = acceptSpoken(result.value, input.questions);
      if (!spoken) throw new Error('unusable');
      return spoken;
    },
  };
}

export async function composeSharedGroupLine(
  database: Database,
  input: {
    familyId: string;
    request: SharedGroupVoiceRequest;
    language: string;
    parentWords?: string | null;
    threadSaid?: readonly SharedGroupThreadLine[];
    deny?: readonly string[];
    voice: SharedGroupComposer | undefined;
  },
): Promise<
  | { send: true; body: string; source: SharedGroupLineSource }
  | { send: false; fallback: SharedGroupLineFallback }
> {
  const lineInput = sharedGroupLineInput(input.request, input.language, {
    parentWords: input.parentWords,
    threadSaid: input.threadSaid,
  });
  const composer = input.voice ?? productionComposer({ familyId: input.familyId, database });
  if (!composer) {
    await pageUnsent(input.request.kind, 'voice_unavailable');
    await auditUnsent(database, input.familyId, input.request.kind, 'voice_unavailable');
    return { send: false, fallback: 'voice_unavailable' };
  }
  let last: SharedGroupLineFallback = 'model_failed';
  for (const prompt of ['full', 'short'] as const) {
    try {
      const spoken = await composer.compose(lineInput, { prompt });
      if (!spoken.send) {
        return { send: false, fallback: 'declined' };
      }
      if (spoken.line && sharedLineUsable(spoken.line, lineInput, input.deny ?? [])) {
        return {
          send: true,
          body: spoken.line,
          source: prompt === 'full' ? 'composed' : 'retry',
        };
      }
      last = 'unusable';
    } catch {
      last = 'model_failed';
    }
  }
  await pageUnsent(input.request.kind, last);
  await auditUnsent(database, input.familyId, input.request.kind, last);
  return { send: false, fallback: last };
}

async function auditUnsent(
  database: Database,
  familyId: string,
  kind: SharedGroupVoiceKind,
  fallback: SharedGroupLineFallback,
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'group_line_unsent',
    targetTable: 'channel_messages',
    targetId: familyId,
    after: { kind, fallback, door: 'shared_group' },
  });
}
