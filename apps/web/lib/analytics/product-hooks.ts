import type { Database } from '@hale/db';
import { groupFamilyCount } from './groups';
import {
  captureErrorEvent,
  captureProductEvent,
  productChannel,
  type TaskType,
} from './product';

/**
 * Fire-and-forget launch events at DB-write seams. A throw here must never reach the
 * parent reply: every helper swallows, and callers must not await.
 */

function fire(work: () => Promise<void>): void {
  void work().catch((err) => {
    console.warn('analytics: launch hook failed', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  });
}

export function noteMessage(args: {
  direction: 'in' | 'out';
  familyId: string;
  channel: string;
  isGroup?: boolean | null;
  chatId?: string | null;
  mediaKind?: string;
  latencyMs?: number;
  database?: Database;
}): void {
  fire(async () => {
    const isGroup = args.isGroup === true;
    const familyCount =
      isGroup && args.database ? await groupFamilyCount(args.database, args.chatId) : 1;
    captureProductEvent({
      event: args.direction === 'in' ? 'message_inbound' : 'message_outbound',
      familyId: args.familyId,
      chatId: isGroup ? args.chatId : undefined,
      properties: {
        channel: productChannel({ channel: args.channel, isGroup }),
        is_group: isGroup,
        family_count: familyCount,
        media_type: args.mediaKind ?? 'none',
        // `reply_ms`, not `latency_ms`: buildEvent drops any key containing `lat`.
        ...(typeof args.latencyMs === 'number' ? { reply_ms: args.latencyMs } : {}),
      },
    });
  });
}

export function noteOnboardingStep(args: {
  sessionId: string;
  step: string;
  familyId?: string | null;
}): void {
  captureProductEvent({
    event: 'onboarding_step',
    sessionId: args.sessionId,
    familyId: args.familyId,
    properties: { step: args.step },
  });
}

export function noteOnboardingCompleted(args: {
  sessionId: string;
  familyId?: string | null;
}): void {
  captureProductEvent({
    event: 'onboarding_completed',
    sessionId: args.sessionId,
    familyId: args.familyId,
  });
}

export function noteFamilySignedUp(args: { familyId: string }): void {
  captureProductEvent({ event: 'family_signed_up', familyId: args.familyId });
}

export function noteGroupChatCreated(args: {
  familyId: string;
  chatId: string;
  familyCount: number;
}): void {
  captureProductEvent({
    event: 'group_chat_created',
    familyId: args.familyId,
    chatId: args.chatId,
    properties: { family_count: args.familyCount },
  });
}

export function noteGroupChatMemberAdded(args: {
  familyId: string;
  chatId: string;
  database?: Database;
  familyCount?: number;
}): void {
  fire(async () => {
    const familyCount =
      args.familyCount ??
      (args.database ? await groupFamilyCount(args.database, args.chatId) : 1);
    captureProductEvent({
      event: 'group_chat_member_added',
      familyId: args.familyId,
      chatId: args.chatId,
      properties: { family_count: familyCount },
    });
  });
}

export function noteTaskCompleted(args: {
  familyId: string;
  type: TaskType;
  source: string;
}): void {
  captureProductEvent({
    event: 'task_completed',
    familyId: args.familyId,
    properties: { type: args.type, source: args.source },
  });
}

export function noteSendFailed(args: {
  familyId: string;
  channel?: string;
  isGroup?: boolean | null;
  chatId?: string | null;
  reason?: string;
}): void {
  captureErrorEvent({
    event: 'send_failed',
    familyId: args.familyId,
    chatId: args.isGroup ? args.chatId : undefined,
    properties: {
      channel: productChannel({
        channel: args.channel ?? 'sms',
        isGroup: args.isGroup,
      }),
      is_group: args.isGroup === true,
      reason: args.reason ?? 'unknown',
    },
  });
}

export function noteTurnFailed(args: {
  familyId: string;
  reason?: string;
  chatId?: string | null;
}): void {
  captureErrorEvent({
    event: 'turn_failed',
    familyId: args.familyId,
    chatId: args.chatId,
    properties: { reason: args.reason ?? 'unknown' },
  });
}

export function noteRegistrationRunFailed(args: {
  familyId: string;
  providerDomain?: string | null;
  stage: string;
  source: string;
}): void {
  captureErrorEvent({
    event: 'registration_run_failed',
    familyId: args.familyId,
    properties: {
      stage: args.stage,
      source: args.source,
      ...(args.providerDomain ? { provider_domain: args.providerDomain } : {}),
    },
  });
}
