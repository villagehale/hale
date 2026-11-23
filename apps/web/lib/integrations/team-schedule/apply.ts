import { type Database, schema } from '@hale/db';
import { askTierFor } from '@hale/tools-contracts';
import type { ActionType, CalendarPlacementPayload } from '@hale/types';
import {
  autonomyTurnOnDelivered,
  loadAutonomyStanding,
  loadFamilyCreatedAt,
} from '@hale/worker/memory-writer';
import { defaultExecuteApprovedDeps, executeApprovedAction } from '@hale/worker/orchestrator';
import { askPolicyTiersEnabled, withinObservationWindow } from '@hale/worker/autonomy-gate';
import { and, eq, isNull } from 'drizzle-orm';
import { mintChannelCalendarDraft } from '~/lib/channel/coach/draft';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type ProactiveHoldReason,
  type ProactiveSendVerdict,
  PROACTIVE_CATEGORY,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
  holdStatus,
} from '~/lib/channel/outbound-gate';
import {
  failedSendPatch,
  readSendRefusal,
  sendLinqChatMessage,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { POLICY_VERSION } from '~/lib/consent';
import { type OpsPager, failurePageOpsPager } from '~/lib/monitoring/failure-page';
import { pipelineClient } from '~/lib/pipeline/client';
import type { FamilyChildRef, SentinelClassification } from '~/lib/sentinel';
import {
  type DriverNotifyPorts,
  driverNotice,
  loadAffectedDrivers,
  notifyDrivers,
  parentDrivers,
  productionDriverNotifyPorts,
  reanchorCarpoolReminders,
  reanchorEventReminders,
} from './driver';
import { teamScheduleChangesActive } from './flag';
import {
  type MatchChange,
  type MatchableKind,
  type ScheduleMatch,
  isMatchableKind,
  loadScheduleCandidates,
  matchTeamSchedule,
} from './match';
import { scrubScheduleFacts } from './scrub';
import {
  type SpokenChange,
  type TeamScheduleVoiceMode,
  composeTeamScheduleDriver,
  composeTeamScheduleParent,
  voiceFacts,
} from './voice';

/**
 * VIL-662 · after the sentinel classifies a coach / league / TeamSnap email,
 * match it to one existing kid event and either ask the parent or apply it.
 *
 * Unmatched mail falls through to the existing email-alert notice. Matched mail
 * replaces that notice so the parent is not told twice.
 */

export const TEAM_SCHEDULE_PARENT_TEMPLATE_KEY = 'team_schedule:parent';

export type TeamScheduleOutcome =
  | 'schedule_change_asked'
  | 'schedule_change_applied'
  | 'schedule_change_unwritten'
  | 'send_failed'
  | 'no_send_target'
  | 'no_chat'
  | `gate_refused:${ProactiveHoldReason}`;

export type TeamScheduleResult =
  | { handled: false }
  | { handled: true; outcome: TeamScheduleOutcome };

export interface TeamScheduleApplyInput {
  familyId: string;
  parentUserId: string;
  integrationId: string;
  messageId: string;
  timeZone: string;
  now: Date;
  classification: SentinelClassification;
  children: readonly FamilyChildRef[];
}

export interface TeamScheduleApplyPorts {
  match(input: {
    kind: MatchableKind;
    facts: ReturnType<typeof scrubScheduleFacts>;
    kid: string | null;
    was: string | null;
    when: string | null;
    candidates: Awaited<ReturnType<typeof loadScheduleCandidates>>;
    familyId: string;
  }): Promise<ScheduleMatch>;
  composeParent(input: {
    mode: TeamScheduleVoiceMode;
    kid: string | null;
    team: string | null;
    change: SpokenChange;
    wasAt: Date | null;
    whenAt: Date | null;
    place: string | null;
    language: string;
    timeZone: string;
  }): Promise<string | null>;
  draft(input: {
    actionType: 'calendar_move' | 'calendar_cancel';
    payload: CalendarPlacementPayload;
    rationale: string;
    teenContent: boolean;
  }): Promise<{ actionId: string }>;
  autonomous(actionType: ActionType): Promise<{ autonomous: boolean; parentUserId: string | null }>;
  execute(actionId: string, approvedBy: string): Promise<void>;
  gate(request: {
    familyId: string;
    parentUserId: string;
    now: Date;
  }): Promise<ProactiveSendVerdict>;
  resolvePhone(database: Database, parentUserId: string): Promise<string | null>;
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
  parentLanguage(parentUserId: string): Promise<string>;
  driver: DriverNotifyPorts;
  /**
   * VIL-719 · tells #ops when the text after an applied change (this lane's tell-after)
   * could not be written. Required (rule #11); read only while ASK_POLICY_TIERS_ENABLED is
   * on for the family.
   */
  pager: OpsPager;
}

function asSpoken(change: MatchChange): SpokenChange | null {
  return change === 'none' ? null : change;
}

function kidName(children: readonly FamilyChildRef[], childId: string | null): string | null {
  if (!childId) return null;
  return children.find((child) => child.id === childId)?.name ?? null;
}

async function actionApproved(database: Database, actionId: string): Promise<boolean> {
  const [row] = await database
    .select({ reviewerVerdict: schema.actions.reviewerVerdict })
    .from(schema.actions)
    .where(eq(schema.actions.id, actionId))
    .limit(1);
  return row?.reviewerVerdict === 'approved';
}

/** The executor's success state. A refused change stays drafted; a failed one needs a human. */
async function actionExecuted(database: Database, actionId: string): Promise<boolean> {
  const [row] = await database
    .select({
      userVisibleState: schema.actions.userVisibleState,
      executedAt: schema.actions.executedAt,
    })
    .from(schema.actions)
    .where(eq(schema.actions.id, actionId))
    .limit(1);
  return row?.userVisibleState === 'autonomous' && row.executedAt !== null;
}

/**
 * VIL-719 · this change would text someone outside the family's own parents, which is ask
 * first. The whole change waits for the parent's yes, because a grant covers the family's
 * calendar and not a message to someone else.
 */
async function changeTextsOutsider(
  database: Database,
  input: { familyId: string; familyEventId: string; originalStartsAt: Date; timeZone: string },
): Promise<boolean> {
  if (!askPolicyTiersEnabled(input.familyId)) return false;
  const drivers = await loadAffectedDrivers(database, input);
  return (await parentDrivers(database, input.familyId, drivers)).length < drivers.length;
}

/**
 * VIL-719 · a draft the parent was never asked about leaves the yes list, so a later plain
 * yes cannot approve it. The row names one parent's email, so it stays with that parent.
 */
async function takeOffYesList(
  database: Database,
  input: { familyId: string; parentUserId: string; actionId: string; change: SpokenChange },
): Promise<void> {
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const held = await tx
      .update(schema.actions)
      .set({ userVisibleState: 'needs_human' })
      .where(
        and(
          eq(schema.actions.id, input.actionId),
          eq(schema.actions.userVisibleState, 'drafted_for_approval'),
        ),
      )
      .returning({ id: schema.actions.id });
    if (held.length === 0) return;
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'team_schedule_change_not_run',
      audience: input.parentUserId,
      targetTable: 'users',
      targetId: input.parentUserId,
      after: { actionId: input.actionId, change: input.change },
    });
  });
}

/**
 * VIL-719 · the executor did not land a change made under a grant. A refused one is taken
 * off the parent's yes list, because they were never asked about it. A failed one is
 * already off it and pages #ops. Either way the normal email notice tells the parent.
 */
async function settleUnrunChange(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    actionId: string;
    change: SpokenChange;
    threw: boolean;
  },
  pager: OpsPager,
): Promise<TeamScheduleResult> {
  const [action] = await database
    .select({
      userVisibleState: schema.actions.userVisibleState,
      executedAt: schema.actions.executedAt,
    })
    .from(schema.actions)
    .where(eq(schema.actions.id, input.actionId))
    .limit(1);
  const failed =
    input.threw || (action?.userVisibleState === 'needs_human' && action.executedAt !== null);
  const page = failed
    ? await pager.page({
        site: 'team_schedule_not_applied',
        facts: { change: input.change },
        ref: input.actionId,
      })
    : null;
  await takeOffYesList(database, input);
  console.info(
    {
      familyId: input.familyId,
      outcome: failed ? 'schedule_change_failed' : 'schedule_change_refused',
      ...(page ? { page } : {}),
    },
    'team schedule: the change did not run, the email notice takes over',
  );
  return { handled: false };
}

export async function calendarKindAutonomous(
  database: Database,
  familyId: string,
  actionType: ActionType,
  now: Date,
): Promise<{ autonomous: boolean; parentUserId: string | null }> {
  if (process.env.AUTONOMOUS_EXECUTE_ENABLED !== 'true') {
    return { autonomous: false, parentUserId: null };
  }
  // VIL-719 · this lane applies a change through executeApprovedAction with the grant
  // holder standing in as the approver, which is not that parent's yes to this change. So
  // it may never carry an ask-first kind; one would wait for the parent instead.
  if (askPolicyTiersEnabled(familyId) && askTierFor(actionType) === 'ask_first') {
    return { autonomous: false, parentUserId: null };
  }
  const createdAt = await loadFamilyCreatedAt(familyId, database);
  if (withinObservationWindow(createdAt, now)) {
    return { autonomous: false, parentUserId: null };
  }
  if (!(await autonomyTurnOnDelivered(familyId, actionType, database))) {
    return { autonomous: false, parentUserId: null };
  }
  const standing = await loadAutonomyStanding(familyId, actionType, database);
  const holder = standing.find((parent) => parent.streakReached && parent.optedIn);
  if (!holder) return { autonomous: false, parentUserId: null };
  return { autonomous: true, parentUserId: holder.parentUserId };
}

export async function applyTeamScheduleChange(
  database: Database,
  input: TeamScheduleApplyInput,
  ports: TeamScheduleApplyPorts,
): Promise<TeamScheduleResult> {
  if (!teamScheduleChangesActive(input.familyId)) return { handled: false };
  const extraction = input.classification.extraction;
  if (input.classification.status !== 'classified' || extraction === null) {
    return { handled: false };
  }
  if (extraction.teenContent) return { handled: false };
  if (!isMatchableKind(extraction.kind)) return { handled: false };

  const facts = scrubScheduleFacts({
    title: extraction.event.title,
    location: extraction.event.location,
    address: extraction.event.address,
  });
  const candidates = await loadScheduleCandidates(database, {
    familyId: input.familyId,
    event: extraction.event,
    receivedAt:
      extraction.event.originalTime ?? extraction.event.newTime ?? input.now.toISOString(),
    timeZone: input.timeZone,
    children: input.children,
  });
  const match = await ports.match({
    kind: extraction.kind,
    facts,
    kid: kidName(input.children, extraction.event.childRef),
    was: extraction.event.originalTime,
    when: extraction.event.newTime,
    candidates,
    familyId: input.familyId,
  });
  const spoken = asSpoken(match.change);
  if (match.eventId === null || spoken === null) return { handled: false };

  const candidate = candidates.find((row) => row.id === match.eventId);
  if (!candidate) return { handled: false };

  const [live] = await database
    .select({
      id: schema.familyEvents.id,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      location: schema.familyEvents.location,
      childId: schema.familyEvents.childId,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.id, match.eventId),
        eq(schema.familyEvents.familyId, input.familyId),
        isNull(schema.familyEvents.deletedAt),
      ),
    )
    .limit(1);
  if (!live) return { handled: false };

  const newStartsAt =
    spoken === 'cancel' || spoken === 'location'
      ? live.startsAt
      : match.newStartsAt
        ? new Date(match.newStartsAt)
        : null;
  if (spoken !== 'cancel' && spoken !== 'location' && newStartsAt === null) {
    return { handled: false };
  }
  const durationMs = live.endsAt !== null ? live.endsAt.getTime() - live.startsAt.getTime() : null;
  const newEndsAt =
    newStartsAt !== null && durationMs !== null && durationMs > 0
      ? new Date(newStartsAt.getTime() + durationMs)
      : null;
  const newLocation = spoken === 'time' || spoken === 'cancel' ? null : match.newLocation;
  const actionType = spoken === 'cancel' ? 'calendar_cancel' : 'calendar_move';
  const payload: CalendarPlacementPayload = {
    title: live.title,
    startsAt: (newStartsAt ?? live.startsAt).toISOString(),
    endsAt: (newEndsAt ?? live.endsAt)?.toISOString() ?? null,
    location: newLocation ?? live.location,
    childId: live.childId,
    reversalHandle: live.id,
    ...(spoken === 'location' || spoken === 'both' ? { updateLocation: true as const } : {}),
  };

  const granted = await ports.autonomous(actionType);
  const standing =
    granted.autonomous &&
    (await changeTextsOutsider(database, {
      familyId: input.familyId,
      familyEventId: live.id,
      originalStartsAt: live.startsAt,
      timeZone: input.timeZone,
    }))
      ? { autonomous: false, parentUserId: null }
      : granted;
  const mode: TeamScheduleVoiceMode = standing.autonomous ? 'applied' : 'ask';
  const language = await ports.parentLanguage(input.parentUserId);
  const text = await ports.composeParent({
    mode,
    kid:
      kidName(input.children, live.childId) ?? kidName(input.children, extraction.event.childRef),
    team: facts.team ?? live.title,
    change: spoken,
    wasAt: live.startsAt,
    whenAt: spoken === 'cancel' ? null : (newStartsAt ?? live.startsAt),
    place: newLocation ?? live.location,
    language,
    timeZone: input.timeZone,
  });
  // Ask path: no parent text means no draft left waiting for a yes nobody heard.
  if (text === null && !standing.autonomous) {
    console.info(
      { familyId: input.familyId, outcome: 'schedule_change_unwritten' },
      'team schedule: parent text unwritten',
    );
    return { handled: true, outcome: 'schedule_change_unwritten' };
  }

  let drafted: { actionId: string };
  try {
    drafted = await ports.draft({
      actionType,
      payload,
      rationale: 'team schedule change from a connected Gmail',
      teenContent: false,
    });
  } catch (err) {
    console.warn(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'team schedule: draft failed',
    );
    return { handled: false };
  }
  if (!(await actionApproved(database, drafted.actionId))) return { handled: false };

  await database.insert(schema.teamScheduleChanges).values({
    familyId: input.familyId,
    actionId: drafted.actionId,
    familyEventId: live.id,
    gmailMessageId: input.messageId,
    changeKind: spoken,
    originalStartsAt: live.startsAt,
    timeZone: input.timeZone,
    newStartsAt: spoken === 'cancel' ? null : (newStartsAt ?? null),
    newEndsAt: spoken === 'cancel' ? null : newEndsAt,
    newLocation,
  });

  if (standing.autonomous && standing.parentUserId) {
    let threw = false;
    try {
      await ports.execute(drafted.actionId, standing.parentUserId);
    } catch (err) {
      if (!askPolicyTiersEnabled(input.familyId)) throw err;
      threw = true;
      console.error(
        { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
        'team schedule: the executor threw',
      );
    }
    // VIL-719 · the executor refuses a change outside the action window and can fail one.
    // With the policy on, a change that did not land is not told or acted on as applied.
    if (
      askPolicyTiersEnabled(input.familyId) &&
      !(await actionExecuted(database, drafted.actionId))
    ) {
      return settleUnrunChange(
        database,
        {
          familyId: input.familyId,
          parentUserId: input.parentUserId,
          actionId: drafted.actionId,
          change: spoken,
          threw,
        },
        ports.pager,
      );
    }
    await applyTeamScheduleEffects(
      database,
      {
        actionId: drafted.actionId,
        familyId: input.familyId,
        now: input.now,
        parentDriversOnly: askPolicyTiersEnabled(input.familyId),
      },
      ports.driver,
    );
  }

  if (text === null) {
    // VIL-719 · the change was applied and its text could not be written: nothing is sent,
    // the change stands, and ops hears of it while the ask policy is on for this family.
    const applied = standing.autonomous && standing.parentUserId !== null;
    const page =
      applied && askPolicyTiersEnabled(input.familyId)
        ? await ports.pager.page({
            site: 'team_schedule_unwritten',
            facts: { change: spoken },
            ref: drafted.actionId,
          })
        : null;
    console.info(
      { familyId: input.familyId, outcome: 'schedule_change_unwritten', ...(page ? { page } : {}) },
      'team schedule: parent text unwritten after apply',
    );
    return { handled: true, outcome: 'schedule_change_unwritten' };
  }

  const sent = await sendParentNotice(database, input, ports, text);
  if (sent.outcome !== 'sent') {
    if (!standing.autonomous && askPolicyTiersEnabled(input.familyId)) {
      await takeOffYesList(database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        actionId: drafted.actionId,
        change: spoken,
      });
      // A gate hold spent no send key, so the email notice can run and keep the quiet-hours
      // debt that asks again later. Every other ending spent it, and the notice would stop.
      if (sent.outcome.startsWith('gate_refused:')) return { handled: false };
    }
    return { handled: true, outcome: sent.outcome };
  }
  return {
    handled: true,
    outcome: standing.autonomous ? 'schedule_change_applied' : 'schedule_change_asked',
  };
}

async function sendParentNotice(
  database: Database,
  input: TeamScheduleApplyInput,
  ports: TeamScheduleApplyPorts,
  text: string,
): Promise<{ outcome: 'sent' | TeamScheduleOutcome }> {
  const dedupeKey = `email_alert:${input.integrationId}:${input.messageId}`;
  if (await dedupeActive(dedupeKey, database)) {
    return { outcome: 'schedule_change_asked' };
  }
  const verdict = await ports.gate({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
  });
  if (!verdict.allowed) {
    const door = await resolveMessagingDoor(database, input.parentUserId);
    await database.insert(schema.channelMessages).values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: door.channel,
      direction: 'out',
      category: PROACTIVE_CATEGORY.email_alert,
      templateKey: TEAM_SCHEDULE_PARENT_TEMPLATE_KEY,
      dedupeKey: null,
      status: holdStatus(verdict.reason),
    });
    return { outcome: `gate_refused:${verdict.reason}` };
  }
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: PROACTIVE_CATEGORY.email_alert,
      templateKey: TEAM_SCHEDULE_PARENT_TEMPLATE_KEY,
      dedupeKey,
      status: acceptedStatus('sms'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { outcome: 'schedule_change_asked' };

  const to = await ports.resolvePhone(database, input.parentUserId);
  if (!to) {
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'no_send_target' })
      .where(eq(schema.channelMessages.id, claimed.id));
    return { outcome: 'no_send_target' };
  }

  const door = await resolveMessagingDoor(database, input.parentUserId, {
    excludeChatId: await familyGroupChatId(database, input.familyId),
  });
  if (door.channel === 'imessage' && !door.chatId) {
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'no_chat' })
      .where(eq(schema.channelMessages.id, claimed.id));
    return { outcome: 'no_chat' };
  }
  try {
    let providerMessageId: string;
    let carried: 'sms' | 'imessage' = 'sms';
    let chatId: string | null = null;
    if (door.channel === 'imessage' && door.chatId) {
      ({ providerMessageId } = await sendLinqChatMessage({ chatId: door.chatId, text }));
      carried = 'imessage';
      chatId = door.chatId;
    } else {
      const sent = await sendResolvingNewChat(ports.transport, {
        to,
        body: withOptOut(text, verdict.optOut),
      });
      providerMessageId = sent.providerMessageId;
      if (sent.transport === 'imessage') {
        carried = 'imessage';
        chatId = sent.chatId ?? null;
      }
    }
    await database
      .update(schema.channelMessages)
      .set(
        carried === 'imessage'
          ? {
              providerMessageId,
              channel: 'imessage',
              providerChatId: chatId,
              status: acceptedStatus('imessage'),
            }
          : { providerMessageId },
      )
      .where(eq(schema.channelMessages.id, claimed.id));
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'unknown';
    await database
      .update(schema.channelMessages)
      .set(failedSendPatch(code))
      .where(eq(schema.channelMessages.id, claimed.id));
    return { outcome: 'send_failed' };
  }

  const extraction = input.classification.extraction;
  await ports.threadMessage(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    body: text,
    source: {
      kind: 'gmail',
      eventId: extraction?.matchedEventRef?.id ?? null,
      gmailMessageId: input.messageId,
      private: extraction?.teenContent === true,
    },
  });
  return { outcome: 'sent' };
}

export async function applyTeamScheduleEffects(
  database: Database,
  input: {
    actionId: string;
    familyId: string;
    now?: Date;
    /** A run under a grant: nobody outside the family's own parents is texted. */
    parentDriversOnly?: boolean;
  },
  driverPorts?: DriverNotifyPorts,
): Promise<void> {
  const now = input.now ?? new Date();
  const [row] = await database
    .select()
    .from(schema.teamScheduleChanges)
    .where(
      and(
        eq(schema.teamScheduleChanges.actionId, input.actionId),
        eq(schema.teamScheduleChanges.familyId, input.familyId),
        isNull(schema.teamScheduleChanges.effectsAppliedAt),
      ),
    )
    .limit(1);
  if (!row) return;
  // VIL-719 · a parent's yes can land outside the action window and leave the change unrun.
  // With the policy on, its effects wait, unstamped, for the run that lands it.
  if (askPolicyTiersEnabled(input.familyId) && !(await actionExecuted(database, input.actionId))) {
    return;
  }

  const [event] = await database
    .select({
      id: schema.familyEvents.id,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      location: schema.familyEvents.location,
      childId: schema.familyEvents.childId,
      deletedAt: schema.familyEvents.deletedAt,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.id, row.familyEventId),
        eq(schema.familyEvents.familyId, input.familyId),
      ),
    )
    .limit(1);
  if (!event) {
    await database
      .update(schema.teamScheduleChanges)
      .set({ effectsAppliedAt: now })
      .where(eq(schema.teamScheduleChanges.id, row.id));
    return;
  }

  const timeZone = row.timeZone;
  const cancelled = row.changeKind === 'cancel' || event.deletedAt !== null;
  const originalStartsAt = row.originalStartsAt;
  const newStartsAt = cancelled ? null : (row.newStartsAt ?? event.startsAt);

  await reanchorEventReminders(database, {
    familyId: input.familyId,
    familyEventId: event.id,
    startsAt: newStartsAt,
    cancelled,
    timeZone,
    now,
  });
  await reanchorCarpoolReminders(database, {
    familyId: input.familyId,
    originalStartsAt,
    newStartsAt,
    newLocation: row.newLocation,
    cancelled,
    timeZone,
    now,
  });

  if (driverPorts) {
    const [child] = event.childId
      ? await database
          .select({ name: schema.children.name })
          .from(schema.children)
          .where(eq(schema.children.id, event.childId))
          .limit(1)
      : [undefined];
    const affected = await loadAffectedDrivers(database, {
      familyId: input.familyId,
      familyEventId: event.id,
      originalStartsAt,
      timeZone,
    });
    const drivers = input.parentDriversOnly
      ? await parentDrivers(database, input.familyId, affected)
      : affected;
    if (drivers.length < affected.length) {
      console.warn(
        { familyId: input.familyId, held: affected.length - drivers.length },
        'team schedule: a driver outside the family was not texted under the grant',
      );
    }
    await notifyDrivers(
      database,
      {
        changeId: row.id,
        familyId: input.familyId,
        drivers,
        ...driverNotice(row, event, child?.name ?? null),
        now,
      },
      driverPorts,
    );
  }

  await database
    .update(schema.teamScheduleChanges)
    .set({ effectsAppliedAt: now })
    .where(eq(schema.teamScheduleChanges.id, row.id));
}

/** Production wiring: familyId is known at the call, not at port construction. */
export function teamSchedulePortsFor(
  database: Database,
  transport: ChannelTransport,
  familyId: string,
  now: Date,
): TeamScheduleApplyPorts {
  const client = pipelineClient();
  return {
    match: (input) => matchTeamSchedule(client, input),
    composeParent: (input) => composeTeamScheduleParent(client, voiceFacts(input), familyId),
    draft: (input) =>
      mintChannelCalendarDraft(
        {
          familyId,
          actor: 'system',
          origin: { surface: 'private' },
          ...input,
        },
        database,
        client,
        now,
      ),
    autonomous: (actionType) => calendarKindAutonomous(database, familyId, actionType, now),
    execute: (actionId, approvedBy) =>
      executeApprovedAction(
        { actionId, familyId, approvedBy, policyVersion: POLICY_VERSION },
        defaultExecuteApprovedDeps(),
      ),
    gate: (request) =>
      assertProactiveSendAllowed(
        { ...request, kind: 'email_alert' },
        buildOutboundGatePorts(database),
      ),
    resolvePhone: resolveSendablePhone,
    transport,
    threadMessage: threadProactiveMessage,
    parentLanguage: (parentUserId) => readParentLanguage(database, { familyId, parentUserId }),
    pager: failurePageOpsPager(() => database),
    driver: productionDriverNotifyPorts(database, transport, async (input) => {
      const [parent] = await database
        .select({
          locale: schema.users.proactiveLanguage,
          timeZone: schema.users.timezone,
        })
        .from(schema.users)
        .where(eq(schema.users.id, input.userId))
        .limit(1);
      const language = parent?.locale && parent.locale.length > 0 ? parent.locale : 'en';
      return composeTeamScheduleDriver(
        client,
        voiceFacts({
          mode: 'applied',
          kid: input.kid,
          team: input.team,
          change: input.change,
          wasAt: input.wasAt,
          whenAt: input.whenAt,
          place: input.place,
          language,
          timeZone: parent?.timeZone && parent.timeZone.length > 0 ? parent.timeZone : 'UTC',
        }),
        familyId,
        input.signal,
      );
    }),
  };
}

async function familyGroupChatId(database: Database, familyId: string): Promise<string | null> {
  const [row] = await database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.linqGroupChatId ?? null;
}
