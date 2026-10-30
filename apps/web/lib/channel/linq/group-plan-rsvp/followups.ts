import type { ReplyLanguage } from '~/lib/channel/language';
import { PROACTIVE_QUIET_HOURS } from '~/lib/channel/outbound-gate';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { linqGroupPlanRsvpEnabled } from '../config';
import { groupPlanRsvpLineInput } from './facts';
import type { GroupPlanRsvpStore } from './store';
import {
  type GroupPlanRsvpComposer,
  composeGroupPlanRsvpLine,
  productionGroupPlanRsvpComposer,
} from './voice';

/**
 * VIL-442 (T15) — one follow-up wave for people who have not answered.
 *
 * Deduped by claim-before-send (one wave per plan). Quiet hours are the
 * covering family's local window. The model writes the nudge from waiting
 * names and the deadline. A missed send releases the claim.
 */

export const GROUP_PLAN_FOLLOWUP_WAVE = 1;

export interface GroupPlanFollowupResult {
  evaluated: number;
  sent: number;
  deduped: number;
  quietHours: number;
  failed: number;
  skipped: number;
}

export interface GroupPlanFollowupDeps {
  store: GroupPlanRsvpStore;
  composer?: GroupPlanRsvpComposer;
  send: (input: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  language?: ReplyLanguage;
  enabled?: () => boolean;
}

export function followupBlockedByQuietHours(now: Date, timeZone: string): boolean {
  return isWithinQuietHours(now, timeZone, PROACTIVE_QUIET_HOURS.start, PROACTIVE_QUIET_HOURS.end);
}

export async function runGroupPlanFollowups(
  deps: GroupPlanFollowupDeps,
  now: Date = new Date(),
): Promise<GroupPlanFollowupResult> {
  const result: GroupPlanFollowupResult = {
    evaluated: 0,
    sent: 0,
    deduped: 0,
    quietHours: 0,
    failed: 0,
    skipped: 0,
  };
  const enabled = deps.enabled ?? linqGroupPlanRsvpEnabled;
  if (!enabled()) return result;

  const due = await deps.store.listDueFollowups(now);
  for (const item of due) {
    result.evaluated += 1;
    if (followupBlockedByQuietHours(now, item.timeZone)) {
      result.quietHours += 1;
      continue;
    }
    const claimed = await deps.store.claimFollowup(item.plan.id, GROUP_PLAN_FOLLOWUP_WAVE, now);
    if (!claimed) {
      result.deduped += 1;
      continue;
    }
    const { tally } = await deps.store.loadTally(item.plan.id);
    if (tally.toGo === 0) {
      await deps.store.releaseFollowup(item.plan.id, GROUP_PLAN_FOLLOWUP_WAVE);
      result.skipped += 1;
      continue;
    }
    const spoken = await composeGroupPlanRsvpLine(
      groupPlanRsvpLineInput({
        kind: 'follow_up',
        language: deps.language ?? 'en',
        title: item.plan.title,
        deadline: item.plan.rsvpDeadlineAt?.toISOString() ?? null,
        tally,
      }),
      deps.composer ?? productionGroupPlanRsvpComposer(),
    );
    if (spoken.status === 'skipped') {
      await deps.store.releaseFollowup(item.plan.id, GROUP_PLAN_FOLLOWUP_WAVE);
      console.warn(
        { outcome: 'group_plan_followup_unsent', reason: spoken.reason },
        'group plan rsvp: follow-up not sent',
      );
      result.skipped += 1;
      continue;
    }
    try {
      await deps.send({ chatId: item.plan.chatId, text: spoken.line });
      await deps.store.markFollowupSent(item.plan.id, GROUP_PLAN_FOLLOWUP_WAVE, now);
      result.sent += 1;
    } catch (err) {
      await deps.store.releaseFollowup(item.plan.id, GROUP_PLAN_FOLLOWUP_WAVE);
      console.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'group plan rsvp: follow-up send failed',
      );
      result.failed += 1;
    }
  }
  return result;
}
