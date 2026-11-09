import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject, voiceClient } from '~/lib/loop/voice/compose';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';

/**
 * VIL-445 — one carpool line, written by the model from facts.
 *
 * No fallback sentence. Two attempts, then nothing is sent and #ops is paged.
 */

export const CARPOOL_VOICE_ATTEMPTS = 2;
export const CARPOOL_VOICE_MAX_TOKENS = 200;
export const CARPOOL_VOICE_RETRY_MAX_TOKENS = 120;

export const CARPOOL_VOICE_KINDS = [
  'ask_driver',
  'night_before_group',
  'night_before_driver',
] as const;
export type CarpoolVoiceKind = (typeof CARPOOL_VOICE_KINDS)[number];

export interface CarpoolVoiceFacts {
  driver: string | null;
  kids: string | null;
  pickupTime: string | null;
  pickupPlace: string | null;
  event: string | null;
  language: string | null;
}

export interface CarpoolVoiceInput {
  kind: CarpoolVoiceKind;
  facts: CarpoolVoiceFacts;
}

export interface CarpoolComposer {
  compose(input: CarpoolVoiceInput): Promise<string | null>;
}

const lineSchema = z.object({ line: z.string() });

function factSlots(facts: CarpoolVoiceFacts): string[] {
  return Object.values(facts).filter((value): value is string => Boolean(value?.trim()));
}

export function carpoolLineUsable(line: string, kind: CarpoolVoiceKind): boolean {
  const body = line.trim();
  if (body.length === 0) return false;
  if (/https?:\/\//i.test(body)) return false;
  const questions = (body.match(/\?/g) ?? []).length;
  if (kind === 'ask_driver') return questions === 1;
  return questions === 0;
}

async function pageUnsent(kind: CarpoolVoiceKind, reason: string): Promise<void> {
  const outcome = await postOpsSlack(
    `Hale carpool: a ${kind} line was not sent (${reason}). Nothing went to the group.`,
  );
  console.warn({ kind, reason, page: outcome }, 'linq carpool: line not sent');
}

export function createCarpoolComposer(options?: {
  compose?: CarpoolComposer['compose'];
  familyId?: string;
  database?: Parameters<typeof composeVoice>[0]['database'];
}): CarpoolComposer {
  if (options?.compose) return { compose: options.compose };
  return {
    async compose(input) {
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('carpool-voice');
      } catch (err) {
        console.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'carpool voice: skill missing',
        );
        await pageUnsent(input.kind, 'skill_unavailable');
        return null;
      }
      const client = voiceClient() ?? budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
      const parse = (answer: string | null) => {
        if (!answer) return null;
        const raw = firstJsonObject(answer);
        if (!raw) return null;
        try {
          const value = lineSchema.parse(JSON.parse(raw));
          const line = value.line.trim();
          return carpoolLineUsable(line, input.kind) ? { line } : null;
        } catch {
          return null;
        }
      };
      if (options?.database && options.familyId) {
        const composed = await composeVoice({
          skill,
          context: input,
          factSlots: factSlots(input.facts),
          parse,
          voiceStrings: (voice) => [voice.line],
          client,
          database: options.database,
          familyId: options.familyId,
          agentName: 'reply-copy',
          traceName: 'reply-copy',
          maxTokens: CARPOOL_VOICE_MAX_TOKENS,
        });
        if (!composed.voice) {
          await pageUnsent(input.kind, composed.reason ?? 'unusable');
          return null;
        }
        return composed.voice.line;
      }
      // Devin #936 (security) — without the database the line cannot be
      // grounded against the supplied facts, so nothing is sent.
      await pageUnsent(input.kind, 'ungrounded');
      return null;
    },
  };
}

export function fakeCarpoolComposer(
  body?: string | ((input: CarpoolVoiceInput) => string),
): CarpoolComposer & { calls: CarpoolVoiceInput[] } {
  const calls: CarpoolVoiceInput[] = [];
  return {
    calls,
    async compose(input) {
      calls.push(input);
      if (typeof body === 'function') return body(input);
      if (body !== undefined) return body;
      const facts = Object.values(input.facts)
        .filter((value): value is string => Boolean(value))
        .join(' ');
      return input.kind === 'ask_driver' ? `${input.kind} ${facts}?` : `${input.kind} ${facts}`;
    },
  };
}
