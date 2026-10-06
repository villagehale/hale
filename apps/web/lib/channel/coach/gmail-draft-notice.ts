import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { isGsm7 } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import type { GmailDraftOperation } from '~/lib/integrations/gmail-draft-service';
import { forceToolJson } from '~/lib/pipeline/structured';

/** One text. A notice that needs two segments was explaining itself. */
export const MAX_NOTICE_CHARS = 160;

/** The first failure is told what it did wrong. The second failure sends nothing. */
export const MAX_NOTICE_ATTEMPTS = 2;

const LINK_SHAPE = /https?:\/\/|www\./i;
const KEYWORD_YES = /\breply\s+yes\b|\byes to\b/i;
const CLAIMS_SENT = /\b(i sent|i've sent|i emailed|email sent|sent the email|sent it|i mailed)\b/i;
const APP_POINTER = /\b(the app|in-app|your dashboard|the website|villagehale)\b/i;

const noticeSchema = z.object({ notice: z.string() });

const noticeJsonSchema = {
  type: 'object',
  properties: { notice: { type: 'string' } },
  required: ['notice'],
} as const;

export class GmailDraftNoticeUnsent extends Error {
  constructor() {
    super('gmail draft notice was not sent');
    this.name = 'GmailDraftNoticeUnsent';
  }
}

export function isGmailDraftNoticeUnsent(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof GmailDraftNoticeUnsent) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

/** What kept a sentence off the parent's phone. Names only — the sentence is not logged. */
export function noticeProblems(raw: string): string[] {
  const text = plainText(raw);
  const problems: string[] = [];
  if (!text) problems.push('empty');
  if (text.length > MAX_NOTICE_CHARS) problems.push('too_long');
  if (text && !isGsm7(text)) problems.push('not_gsm7');
  if (LINK_SHAPE.test(text)) problems.push('link');
  if (KEYWORD_YES.test(text)) problems.push('keyword_yes');
  if (CLAIMS_SENT.test(text)) problems.push('claims_sent');
  if (APP_POINTER.test(text)) problems.push('app_pointer');
  return problems;
}

function situation(operation: GmailDraftOperation): string {
  if (operation === 'delete') {
    return 'You removed a Gmail draft Hale had prepared. Hale did not send any email.';
  }
  if (operation === 'update') {
    return 'You updated a Gmail draft. The parent reviews it and sends it themselves. Hale did not send any email.';
  }
  return 'You prepared a Gmail draft in the parent Gmail. They review it and send it themselves. Hale did not send any email.';
}

function userMessage(
  operation: GmailDraftOperation,
  rejected: readonly { notice: string; problems: string[] }[],
): string {
  return JSON.stringify({
    situation: situation(operation),
    ...(rejected.length > 0 ? { rejected } : {}),
  });
}

/**
 * The sentence the parent gets after a draft is real. Two attempts, then null.
 * Null means the caller sends nothing and the router pages #ops. This function
 * does not page, and it does not substitute a stock sentence.
 */
export async function composeGmailDraftNotice(
  client: AgentClient,
  operation: GmailDraftOperation,
): Promise<string | null> {
  const skill = await loadCronSkill('gmail-draft-notice');
  const rejected: { notice: string; problems: string[] }[] = [];
  for (let attempt = 0; attempt < MAX_NOTICE_ATTEMPTS; attempt += 1) {
    let notice: string;
    try {
      const result = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: userMessage(operation, rejected),
        toolName: 'gmail_draft_notice',
        toolDescription: 'The one sentence the parent is texted about a Gmail draft.',
        inputJsonSchema: noticeJsonSchema,
        schema: noticeSchema,
        maxTokens: 96,
      });
      notice = result.value.notice;
    } catch (err) {
      console.error(
        { attempt, reason: err instanceof Error ? err.name : 'unknown' },
        'gmail draft notice: compose failed',
      );
      continue;
    }
    const problems = noticeProblems(notice);
    if (problems.length === 0) return plainText(notice);
    rejected.push({ notice: plainText(notice), problems });
    console.error({ attempt, problems }, 'gmail draft notice: refused');
  }
  return null;
}
