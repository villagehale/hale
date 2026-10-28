import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { linqMultiFamilyGroupsEnabled } from './config';
import { readGroupMembership } from './group-membership';
import { type GroupRsvpCalendarPort, createGroupRsvpCalendarPort } from './group-rsvp-calendar';
import { groupRsvpLineInput } from './group-rsvp-line-input';
import {
  type GroupRsvpReader,
  type GroupRsvpReading,
  readingOrUnclear,
  sharedGroupRsvpReader,
} from './group-rsvp-read';
import {
  type RsvpTally,
  type TallyHousehold,
  householdKeyFor,
  tallyChangedMeaningfully,
  tallyHouseholds,
} from './group-rsvp-tally';
import {
  type GroupRsvpComposer,
  type GroupRsvpLineSend,
  sendGroupRsvpLine,
} from './group-rsvp-voice';
import { firstName, primaryParentId } from './roster-ask';

/**
 * VIL-102 — keep a yes/no/pending household count from a group chat, report it
 * in AI-written words, and write the plan onto each yes household's calendar
 * after that household said the write was ok.
 *
 * Works in a claimed household group now. A multi-family group uses joined
 * families when that flag is on. Members who are not Hale customers still
 * count. Hale stays quiet during banter.
 */

export type GroupRsvpTurnResult =
  | { handled: false }
  | {
      handled: true;
      outcome: string;
      count: 'intake' | 'ignored' | 'duplicate';
      notice?: string;
      body?: string;
    };

export interface GroupRsvpTurnInput {
  chatId: string;
  senderHandle: string | null;
  text: string;
  tapback: string | null;
  providerMessageId: string;
  receivedAt: Date;
  now: Date;
  replyTo?: string;
}

export interface GroupRsvpPorts {
  reader?: GroupRsvpReader | null;
  voice?: GroupRsvpComposer;
  send?: GroupRsvpLineSend;
  calendar?: GroupRsvpCalendarPort;
}

interface Speaker {
  familyId: string | null;
  userId: string | null;
  displayName: string | null;
  householdKey: string;
  haleCustomer: boolean;
}

const TEMPLATE = {
  started: 'linq:group_rsvp_started',
  tally: 'linq:group_rsvp_tally',
  calendar: 'linq:group_rsvp_calendar',
} as const;

async function audit(
  database: Database,
  entry: {
    familyId: string;
    actor: string;
    actionTaken: string;
    targetId: string;
    after?: Record<string, unknown>;
  },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: entry.familyId,
    actor: entry.actor,
    actionTaken: entry.actionTaken,
    targetTable: 'linq_group_rsvp_plans',
    targetId: entry.targetId,
    after: entry.after ?? {},
  });
}

async function hostFamilyId(
  database: Database,
  chatId: string,
  speaker: Speaker,
): Promise<string | null> {
  const [claimed] = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, chatId))
    .limit(1);
  if (claimed) return claimed.id;
  if (linqMultiFamilyGroupsEnabled()) {
    const [join] = await database
      .select({ familyId: schema.linqMultiFamilyJoins.familyId })
      .from(schema.linqMultiFamilyJoins)
      .where(
        and(
          eq(schema.linqMultiFamilyJoins.chatId, chatId),
          isNull(schema.linqMultiFamilyJoins.leftAt),
        ),
      )
      .limit(1);
    if (join) return join.familyId;
  }
  return speaker.familyId;
}

async function expectedHouseholdKeys(
  database: Database,
  chatId: string,
  hostId: string,
): Promise<string[]> {
  const keys = new Set<string>([`family:${hostId}`]);
  const membership = await readGroupMembership(database, chatId);
  if (membership) keys.add(`family:${membership.familyId}`);
  if (linqMultiFamilyGroupsEnabled()) {
    const joins = await database
      .select({ familyId: schema.linqMultiFamilyJoins.familyId })
      .from(schema.linqMultiFamilyJoins)
      .where(
        and(
          eq(schema.linqMultiFamilyJoins.chatId, chatId),
          isNull(schema.linqMultiFamilyJoins.leftAt),
        ),
      );
    for (const join of joins) keys.add(`family:${join.familyId}`);
  }
  return [...keys];
}

export async function resolveRsvpSpeaker(
  database: Database,
  chatId: string,
  senderHandle: string | null,
): Promise<Speaker | null> {
  if (!senderHandle) return null;
  const phone = normalizePhoneE164(senderHandle);
  if (!phone) return null;
  const hash = phoneBlindIndex(phone);
  const membership = await readGroupMembership(database, chatId);
  if (membership) {
    const [seat] = await database
      .select({ userId: schema.linqGroupMembers.userId })
      .from(schema.linqGroupMembers)
      .where(
        and(
          eq(schema.linqGroupMembers.chatId, chatId),
          eq(schema.linqGroupMembers.phoneE164Hash, hash),
          isNull(schema.linqGroupMembers.removedAt),
        ),
      )
      .limit(1);
    if (seat) {
      const member = membership.members.find((row) => row.userId === seat.userId);
      return {
        familyId: membership.familyId,
        userId: seat.userId,
        displayName: await firstName(database, seat.userId),
        householdKey: `family:${membership.familyId}`,
        haleCustomer: member?.haleCustomer ?? false,
      };
    }
  }
  if (linqMultiFamilyGroupsEnabled()) {
    const [shared] = await database
      .select({
        familyId: schema.linqMultiFamilyMembers.familyId,
        userId: schema.linqMultiFamilyMembers.userId,
      })
      .from(schema.linqMultiFamilyMembers)
      .where(
        and(
          eq(schema.linqMultiFamilyMembers.chatId, chatId),
          eq(schema.linqMultiFamilyMembers.phoneE164Hash, hash),
          isNull(schema.linqMultiFamilyMembers.removedAt),
        ),
      )
      .limit(1);
    if (shared) {
      return {
        familyId: shared.familyId,
        userId: shared.userId,
        displayName: await firstName(database, shared.userId),
        householdKey: `family:${shared.familyId}`,
        haleCustomer: true,
      };
    }
  }
  const channel = await resolveVerifiedChannelByPhone(database, phone);
  if (channel) {
    return {
      familyId: channel.familyId,
      userId: channel.userId,
      displayName: await firstName(database, channel.userId),
      householdKey: `family:${channel.familyId}`,
      haleCustomer: true,
    };
  }
  return {
    familyId: null,
    userId: null,
    displayName: null,
    householdKey: householdKeyFor({ familyId: null, phoneHash: hash }) ?? `phone:${hash}`,
    haleCustomer: false,
  };
}

async function loadOpenPlan(database: Database, chatId: string) {
  const [plan] = await database
    .select()
    .from(schema.linqGroupRsvpPlans)
    .where(
      and(
        eq(schema.linqGroupRsvpPlans.chatId, chatId),
        eq(schema.linqGroupRsvpPlans.status, 'open'),
      ),
    )
    .limit(1);
  return plan ?? null;
}

async function loadTally(
  database: Database,
  planId: string,
  expected: readonly string[],
): Promise<RsvpTally> {
  const rows = await database
    .select()
    .from(schema.linqGroupRsvpReplies)
    .where(eq(schema.linqGroupRsvpReplies.planId, planId));
  return tallyHouseholds(
    rows.map(
      (row): TallyHousehold => ({
        householdKey: row.householdKey,
        displayName: row.displayName,
        response: row.response,
        familyId: row.familyId,
        calendarPermission: row.calendarPermission,
        calendarEventId: row.calendarEventId,
      }),
    ),
    expected,
  );
}

async function upsertReply(
  database: Database,
  input: {
    planId: string;
    speaker: Speaker;
    displayName: string | null;
    response: 'yes' | 'no' | 'pending';
    source: 'text' | 'tapback';
    verbatim: string | null;
    interpretation: string;
    now: Date;
  },
): Promise<void> {
  const [existing] = await database
    .select({ id: schema.linqGroupRsvpReplies.id })
    .from(schema.linqGroupRsvpReplies)
    .where(
      and(
        eq(schema.linqGroupRsvpReplies.planId, input.planId),
        eq(schema.linqGroupRsvpReplies.householdKey, input.speaker.householdKey),
      ),
    )
    .limit(1);
  if (existing) {
    await database
      .update(schema.linqGroupRsvpReplies)
      .set({
        familyId: input.speaker.familyId,
        userId: input.speaker.userId,
        displayName: input.displayName,
        response: input.response,
        source: input.source,
        verbatim: input.verbatim,
        interpretation: input.interpretation,
        updatedAt: input.now,
      })
      .where(eq(schema.linqGroupRsvpReplies.id, existing.id));
    return;
  }
  await database.insert(schema.linqGroupRsvpReplies).values({
    planId: input.planId,
    householdKey: input.speaker.householdKey,
    familyId: input.speaker.familyId,
    userId: input.speaker.userId,
    displayName: input.displayName,
    response: input.response,
    source: input.source,
    verbatim: input.verbatim,
    interpretation: input.interpretation,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

function whenText(startsAt: Date | null): string | null {
  if (!startsAt) return null;
  return startsAt.toISOString();
}

function parseWhen(text: string | null): Date | null {
  if (!text) return null;
  const instant = Date.parse(text);
  return Number.isNaN(instant) ? null : new Date(instant);
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}

async function applyEventFacts(
  database: Database,
  plan: typeof schema.linqGroupRsvpPlans.$inferSelect,
  event: GroupRsvpReading['event'],
  now: Date,
): Promise<typeof schema.linqGroupRsvpPlans.$inferSelect> {
  const title = plan.title ?? event.title;
  const startsAt = plan.startsAt ?? parseWhen(event.whenText);
  const location = plan.location ?? event.location;
  if (title === plan.title && location === plan.location && sameInstant(plan.startsAt, startsAt)) {
    return plan;
  }
  await database
    .update(schema.linqGroupRsvpPlans)
    .set({ title, startsAt, location, updatedAt: now })
    .where(eq(schema.linqGroupRsvpPlans.id, plan.id));
  return { ...plan, title, startsAt, location };
}

async function speakTally(
  database: Database,
  input: {
    hostFamilyId: string;
    chatId: string;
    kind: 'started' | 'tally' | 'calendar_placed';
    parentWords: string | null;
    tally: RsvpTally;
    title: string | null;
    startsAt: Date | null;
    location: string | null;
    justChanged: string | null;
    calendarAskFor: string | null;
    calendarPlacedFor: string | null;
    inviteSent: boolean;
    send: boolean;
    replyTo?: string;
    now: Date;
    voice?: GroupRsvpComposer;
    sendLine?: GroupRsvpLineSend;
  },
): Promise<GroupRsvpTurnResult> {
  const ledgerUserId = await primaryParentId(database, input.hostFamilyId);
  if (!ledgerUserId) {
    console.warn({ outcome: 'rsvp_no_primary_parent' }, 'linq group rsvp: no parent to ledger');
    return { handled: true, outcome: 'rsvp_no_primary_parent', count: 'ignored' };
  }
  const line = groupRsvpLineInput({
    kind: input.kind,
    language: 'en',
    parentWords: input.parentWords,
    tally: input.tally,
    title: input.title,
    whenText: whenText(input.startsAt),
    location: input.location,
    justChanged: input.justChanged,
    calendarAskFor: input.calendarAskFor,
    calendarPlacedFor: input.calendarPlacedFor,
    inviteSent: input.inviteSent,
    send: input.send,
  });
  const notice = await sendGroupRsvpLine(database, {
    familyId: input.hostFamilyId,
    ledgerUserId,
    chatId: input.chatId,
    line,
    replyTo: input.replyTo,
    templateKey: TEMPLATE[input.kind === 'calendar_placed' ? 'calendar' : input.kind],
    dedupeKey: `${TEMPLATE[input.kind === 'calendar_placed' ? 'calendar' : input.kind]}:${input.chatId}:${input.now.toISOString()}`,
    now: input.now,
    voice: input.voice,
    send: input.sendLine,
  });
  if (notice.outcome === 'sent') {
    await audit(database, {
      familyId: input.hostFamilyId,
      actor: ledgerUserId,
      actionTaken:
        input.kind === 'started' ? 'linq_group_rsvp_started' : 'linq_group_rsvp_reported',
      targetId: input.chatId,
      after: { yes: input.tally.yes, no: input.tally.no, pending: input.tally.pending },
    });
    return {
      handled: true,
      outcome: `rsvp_${input.kind}`,
      count: 'intake',
      notice: 'sent',
      body: notice.body,
    };
  }
  if (notice.outcome === 'quiet' || notice.outcome === 'already_sent') {
    return {
      handled: true,
      outcome: `rsvp_${notice.outcome}`,
      count: 'ignored',
      notice: notice.outcome,
    };
  }
  return { handled: true, outcome: notice.outcome, count: 'ignored', notice: notice.outcome };
}

export async function takeGroupRsvpTurn(
  database: Database,
  input: GroupRsvpTurnInput,
  ports: GroupRsvpPorts = {},
): Promise<GroupRsvpTurnResult> {
  const speaker = await resolveRsvpSpeaker(database, input.chatId, input.senderHandle);
  if (!speaker) return { handled: false };

  const plan = await loadOpenPlan(database, input.chatId);
  const reader = ports.reader === undefined ? sharedGroupRsvpReader() : ports.reader;
  if (!reader) {
    if (!plan) return { handled: false };
    console.warn({ outcome: 'rsvp_unread' }, 'linq group rsvp: reader unavailable, staying silent');
    return { handled: true, outcome: 'rsvp_unread', count: 'ignored' };
  }

  const reading = readingOrUnclear(
    await reader.read({
      text: input.text,
      tapback: input.tapback,
      senderName: speaker.displayName,
      haleNames: ['Hale'],
      tracking: plan !== null,
      now: input.now.toISOString(),
      recent: [],
    }),
  );

  if (!plan && reading.intent !== 'track') return { handled: false };
  if (reading.intent === 'chatter' || reading.intent === 'unclear') {
    return plan ? { handled: true, outcome: 'rsvp_quiet', count: 'ignored' } : { handled: false };
  }

  const hostId = plan?.hostFamilyId ?? (await hostFamilyId(database, input.chatId, speaker));
  if (!hostId) {
    console.warn({ outcome: 'rsvp_no_family' }, 'linq group rsvp: no family to ledger');
    return { handled: true, outcome: 'rsvp_no_family', count: 'ignored' };
  }

  if (reading.intent === 'track') {
    const opened = plan
      ? await applyEventFacts(database, plan, reading.event, input.now)
      : (
          await database
            .insert(schema.linqGroupRsvpPlans)
            .values({
              chatId: input.chatId,
              hostFamilyId: hostId,
              title: reading.event.title,
              startsAt: parseWhen(reading.event.whenText),
              location: reading.event.location,
              status: 'open',
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning()
        )[0];
    if (!opened) return { handled: true, outcome: 'rsvp_plan_missing', count: 'ignored' };
    await audit(database, {
      familyId: hostId,
      actor: speaker.userId ?? 'system',
      actionTaken: 'linq_group_rsvp_started',
      targetId: opened.id,
      after: { title: opened.title },
    });
    const expected = await expectedHouseholdKeys(database, input.chatId, hostId);
    const tally = await loadTally(database, opened.id, expected);
    return speakTally(database, {
      hostFamilyId: hostId,
      chatId: input.chatId,
      kind: 'started',
      parentWords: input.text,
      tally,
      title: opened.title,
      startsAt: opened.startsAt,
      location: opened.location,
      justChanged: null,
      calendarAskFor: null,
      calendarPlacedFor: null,
      inviteSent: false,
      send: true,
      replyTo: input.replyTo,
      now: input.now,
      voice: ports.voice,
      sendLine: ports.send,
    });
  }

  if (!plan) return { handled: false };
  const live = await applyEventFacts(database, plan, reading.event, input.now);

  if (reading.intent === 'report') {
    const expected = await expectedHouseholdKeys(database, input.chatId, hostId);
    const tally = await loadTally(database, live.id, expected);
    return speakTally(database, {
      hostFamilyId: hostId,
      chatId: input.chatId,
      kind: 'tally',
      parentWords: input.text,
      tally,
      title: live.title,
      startsAt: live.startsAt,
      location: live.location,
      justChanged: null,
      calendarAskFor: null,
      calendarPlacedFor: null,
      inviteSent: tally.households.some((row) => row.calendarEventId),
      send: true,
      replyTo: input.replyTo,
      now: input.now,
      voice: ports.voice,
      sendLine: ports.send,
    });
  }

  if (reading.intent === 'permission_yes' || reading.intent === 'permission_no') {
    return settlePermission(database, {
      plan: live,
      speaker,
      reading,
      input,
      ports,
      granted: reading.intent === 'permission_yes',
    });
  }

  if (reading.intent !== 'yes' && reading.intent !== 'no' && reading.intent !== 'pending') {
    return { handled: true, outcome: 'rsvp_quiet', count: 'ignored' };
  }

  const expected = await expectedHouseholdKeys(database, input.chatId, hostId);
  const before = await loadTally(database, live.id, expected);
  await upsertReply(database, {
    planId: live.id,
    speaker,
    displayName: reading.householdName ?? speaker.displayName,
    response: reading.intent,
    source: input.tapback && !input.text.trim() ? 'tapback' : 'text',
    verbatim: input.text || input.tapback,
    interpretation: reading.intent,
    now: input.now,
  });
  const after = await loadTally(database, live.id, [...expected, speaker.householdKey]);
  await audit(database, {
    familyId: hostId,
    actor: speaker.userId ?? 'system',
    actionTaken: 'linq_group_rsvp_recorded',
    targetId: live.id,
    after: {
      householdKey: speaker.householdKey,
      response: reading.intent,
      source: input.tapback && !input.text.trim() ? 'tapback' : 'text',
    },
  });

  const meaningful = tallyChangedMeaningfully(before, after);
  const calendarAsk =
    reading.intent === 'yes' && speaker.familyId && speaker.haleCustomer
      ? await maybeAskCalendar(database, live.id, speaker)
      : null;

  if (!meaningful && !calendarAsk) {
    return { handled: true, outcome: 'rsvp_recorded', count: 'ignored' };
  }

  return speakTally(database, {
    hostFamilyId: hostId,
    chatId: input.chatId,
    kind: 'tally',
    parentWords: input.text,
    tally: after,
    title: live.title,
    startsAt: live.startsAt,
    location: live.location,
    justChanged: reading.householdName ?? speaker.displayName,
    calendarAskFor: calendarAsk,
    calendarPlacedFor: null,
    inviteSent: after.households.some((row) => row.calendarEventId),
    send: true,
    replyTo: input.replyTo,
    now: input.now,
    voice: ports.voice,
    sendLine: ports.send,
  });
}

async function maybeAskCalendar(
  database: Database,
  planId: string,
  speaker: Speaker,
): Promise<string | null> {
  const [row] = await database
    .select()
    .from(schema.linqGroupRsvpReplies)
    .where(
      and(
        eq(schema.linqGroupRsvpReplies.planId, planId),
        eq(schema.linqGroupRsvpReplies.householdKey, speaker.householdKey),
      ),
    )
    .limit(1);
  if (!row || row.calendarPermission || row.calendarEventId) return null;
  await database
    .update(schema.linqGroupRsvpReplies)
    .set({ calendarPermission: 'pending' })
    .where(eq(schema.linqGroupRsvpReplies.id, row.id));
  return row.displayName ?? speaker.displayName;
}

async function settlePermission(
  database: Database,
  args: {
    plan: typeof schema.linqGroupRsvpPlans.$inferSelect;
    speaker: Speaker;
    reading: GroupRsvpReading;
    input: GroupRsvpTurnInput;
    ports: GroupRsvpPorts;
    granted: boolean;
  },
): Promise<GroupRsvpTurnResult> {
  const { plan, speaker, input, ports, granted } = args;
  const [row] = await database
    .select()
    .from(schema.linqGroupRsvpReplies)
    .where(
      and(
        eq(schema.linqGroupRsvpReplies.planId, plan.id),
        eq(schema.linqGroupRsvpReplies.householdKey, speaker.householdKey),
      ),
    )
    .limit(1);
  if (!row || row.calendarPermission !== 'pending') {
    return { handled: true, outcome: 'rsvp_permission_ignored', count: 'ignored' };
  }
  if (!granted || !speaker.familyId) {
    await database
      .update(schema.linqGroupRsvpReplies)
      .set({ calendarPermission: 'refused', updatedAt: input.now })
      .where(eq(schema.linqGroupRsvpReplies.id, row.id));
    await audit(database, {
      familyId: plan.hostFamilyId,
      actor: speaker.userId ?? 'system',
      actionTaken: 'linq_group_rsvp_calendar_refused',
      targetId: plan.id,
      after: { householdKey: speaker.householdKey },
    });
    return { handled: true, outcome: 'rsvp_calendar_refused', count: 'ignored' };
  }
  if (!plan.title || !plan.startsAt) {
    return { handled: true, outcome: 'rsvp_event_incomplete', count: 'ignored' };
  }
  const calendar = ports.calendar ?? createGroupRsvpCalendarPort(database);
  const placed = await calendar.place({
    familyId: speaker.familyId,
    actorUserId: speaker.userId,
    title: plan.title,
    startsAt: plan.startsAt,
    location: plan.location,
  });
  if ('skipped' in placed) {
    console.warn({ outcome: placed.skipped }, 'linq group rsvp: calendar write skipped');
    return { handled: true, outcome: 'rsvp_calendar_skipped', count: 'ignored' };
  }
  await database
    .update(schema.linqGroupRsvpReplies)
    .set({
      calendarPermission: 'granted',
      calendarEventId: placed.familyEventId,
      updatedAt: input.now,
    })
    .where(eq(schema.linqGroupRsvpReplies.id, row.id));
  const expected = await expectedHouseholdKeys(database, input.chatId, plan.hostFamilyId);
  const tally = await loadTally(database, plan.id, expected);
  return speakTally(database, {
    hostFamilyId: plan.hostFamilyId,
    chatId: input.chatId,
    kind: 'calendar_placed',
    parentWords: input.text,
    tally,
    title: plan.title,
    startsAt: plan.startsAt,
    location: plan.location,
    justChanged: speaker.displayName,
    calendarAskFor: null,
    calendarPlacedFor: speaker.displayName,
    inviteSent: true,
    send: true,
    replyTo: input.replyTo,
    now: input.now,
    voice: ports.voice,
    sendLine: ports.send,
  });
}
