import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { spokenActionLabel } from '~/lib/format/labels';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-454 (T6) 3/3 — the receipt for a parent's answer, AI-written.
 *
 * Replaces the fixed `approvedReceipt` / `declinedReceipt` / `UNDONE_RECEIPT` lines when
 * `APPROVAL_RECEIPT_VOICE_ENABLED` is exactly `true` (default off: off keeps today's lines
 * byte-for-byte, so nothing re-records to merge). Code owns what was recorded; the model
 * writes the words (skill `approval-receipt`). A compose that fails twice sends nothing:
 * the action is already recorded, and the write notice (VIL-454 2/3) follows on its own.
 */

export type ReceiptKind = 'approved' | 'declined' | 'undone';

export interface ApprovalReceiptInput {
  kind: ReceiptKind;
  action: string;
  language: ReplyLanguage;
}

export type ApprovalReceiptVoice = (input: {
  database: Database;
  kind: ReceiptKind;
  actionType: string;
  familyId: string;
}) => Promise<string | null>;

export function approvalReceiptVoiceEnabled(env: Record<string, string | undefined> = process.env) {
  return env.APPROVAL_RECEIPT_VOICE_ENABLED?.trim() === 'true';
}

export function approvalReceiptInput(
  kind: ReceiptKind,
  actionType: string,
  language: ReplyLanguage,
): ApprovalReceiptInput {
  return { kind, action: spokenActionLabel(actionType), language };
}

/** The user turn. Shared with the eval. */
export function approvalReceiptUserMessage(input: ApprovalReceiptInput): string {
  return JSON.stringify(input);
}

export const APPROVAL_RECEIPT_MAX_CHARS = 240;

/** Structural refusals only: empty, too long, or a link. */
export function approvalReceiptRefusals(body: string): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  const found: string[] = [];
  if (text.length > APPROVAL_RECEIPT_MAX_CHARS) found.push('over_char_cap');
  if (/https?:\/\//i.test(text)) found.push('carries_link');
  return found;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export async function composeApprovalReceipt(
  client: AgentClient,
  input: ApprovalReceiptInput,
): Promise<string | null> {
  const skill = await loadCronSkill('approval-receipt');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: approvalReceiptUserMessage(input),
        toolName: 'approval_receipt',
        toolDescription: 'The one short text Hale sends back.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: 200,
      });
      const text = value.text.trim();
      if (approvalReceiptRefusals(text).length === 0) return text;
    } catch (err) {
      console.warn(
        { attempt, err: err instanceof Error ? err.name : 'unknown' },
        'approval receipt: compose failed',
      );
    }
  }
  console.error(
    { outcome: 'approval_receipt_unwritten', kind: input.kind },
    'approval receipt: nothing sent',
  );
  return null;
}

/**
 * The production voice, or undefined when the flag is off (callers then keep today's
 * fixed lines). `language` is read per family by the caller-supplied reader.
 */
export function productionApprovalReceiptVoice(
  readLanguage: (database: Database, familyId: string) => Promise<ReplyLanguage | null>,
): ApprovalReceiptVoice | undefined {
  if (!approvalReceiptVoiceEnabled()) return undefined;
  return async ({ database, kind, actionType, familyId }) => {
    const language = (await readLanguage(database, familyId)) ?? 'en';
    return composeApprovalReceipt(
      budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS),
      approvalReceiptInput(kind, actionType, language),
    );
  };
}
