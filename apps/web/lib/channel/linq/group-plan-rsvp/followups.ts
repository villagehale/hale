import type { ReplyLanguage } from '~/lib/channel/language';
import { PROACTIVE_QUIET_HOURS } from '~/lib/channel/outbound-gate';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { linqGroupPlanRsvpEnabled } from '../config';
import { groupPlanRsvpLineInput } from './facts';
import { GroupPlanRsvpHeld } from './send';
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
 * names and the deadline. A missed send releases the claim. A follow-up the
 * family-chat floor holds is `held`: a participant read that failed for now
 * releases the claim for a later tick; any other refusal keeps the wave spent.
 */

export const GROUP_PLAN_FOLLOWUP_WAVE = 1;

export interface GroupPlanFollowupResult {
  evaluated: number;
  sent: number;
  deduped: number;
  quietHours: number;
  failed: number;
  skipped: number;
  held: number;
}

export interface GroupPlanFollowupDeps {
  store: GroupPlanRsvpStore;
  composer?: GroupPlanRsvpComposer;
  /** One follow-up, ledgered on the plan's own household and keyed to that plan. */
  send: (input: {
    chatId: string;
    text: string;
    familyId: string;
    planId: string;
  }) => Promise<{ providerMessageId: string }>;
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
    held: 0,
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
      await deps.send({
        chatId: item.plan.chatId,
        text: spoken.line,
        familyId: item.plan.familyId,
        planId: item.plan.id,
      });
      await deps.store.markFollowupSent(item.plan.id, GROUP_PLAN_FOLLOWUP_WAVE, now);
      result.sent += 1;
    } catch (err) {
      if (err instanceof GroupPlanRsvpHeld) {
        if (err.reason === 'participants_unverified') {
          await deps.store.releaseFollowup(item.plan.id, GROUP_PLAN_FOLLOWUP_WAVE);
        }
        console.warn(
          { outcome: 'group_plan_followup_held', reason: err.reason },
          'group plan rsvp: follow-up held by the family-chat floor',
        );
        result.held += 1;
        continue;
      }
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
