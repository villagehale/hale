import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { knownHouseholdTimezone } from '~/lib/channel/household-timezone';
import { groupExperienceTurnEnabled, groupPollsEnabled } from '../config';
import { type OneToOneSend, privateAsideOneToOne } from '../connect-link-1to1';
import { settleGroupPlanCalendarAfterRsvp } from '../group-plan-rsvp/inbound';
import { senderMemberKey } from '../group-plan-rsvp/member-key';
import { createPostgresGroupPlanRsvpStore } from '../group-plan-rsvp/store';
import type { GroupPlanRsvpComposer } from '../group-plan-rsvp/voice';
import { readFamilySliceForAudience } from '../multi-family';
import { lookupLinqPollOption } from '../poll';
import { isGroupExperiencePollKind } from './kinds';
import { postgresExperiencePollCard } from './poll-card';
import type { GroupExperienceReader } from './reading';
import { createPostgresGroupExperienceStore } from './store';
import {
  type GroupExperienceTurnOutcome,
  type GroupExperienceTurnPorts,
  takeGroupExperienceTurn,
} from './turn';
import type { GroupExperienceComposer } from './voice';

export interface GroupExperienceInboundPorts {
  database: Database;
  now: Date;
  send?: (input: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  reader?: GroupExperienceReader;
  composer?: GroupExperienceComposer;
  sendOneToOne?: GroupExperienceTurnPorts['sendOneToOne'];
  /** The 1:1 transport. Absent means production Linq (the door's own test seam). */
  oneToOne?: OneToOneSend;
  /** The VIL-503 calendar ask's writer. Absent means the production model. */
  calendarComposer?: GroupPlanRsvpComposer;
}

function calendarSettle(ports: GroupExperienceInboundPorts, chatId: string) {
  return (answer: Parameters<NonNullable<GroupExperienceTurnPorts['settleCalendar']>>[0]) =>
    settleGroupPlanCalendarAfterRsvp(
      {
        database: ports.database,
        now: ports.now,
        oneToOne: ports.oneToOne,
        composer: ports.calendarComposer,
      },
      { chatId, ...answer },
    );
}

async function senderNameOf(database: Database, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.name?.trim().split(/\s+/)[0] || null;
}

function productionOneToOne(
  database: Database,
  now: Date,
  send: OneToOneSend | undefined,
): NonNullable<GroupExperienceTurnPorts['sendOneToOne']> {
  const aside = privateAsideOneToOne(database, { now, send });
  return async (input) => {
    const textOut = await aside({
      familyId: input.familyId,
      text: input.text,
      dedupeKey: input.dedupeKey,
    });
    return textOut === 'sent' || textOut === 'suppressed' ? 'sent' : 'not_sent';
  };
}

export async function considerGroupExperience(
  ports: GroupExperienceInboundPorts,
  input: {
    chatId: string;
    senderHandle: string;
    senderUserId?: string | null;
    senderFamilyId?: string | null;
    coveringFamilyId: string;
    text: string;
  },
): Promise<GroupExperienceTurnOutcome> {
  if (!groupExperienceTurnEnabled()) return { handled: false };
  const senderUserId = input.senderUserId ?? null;
  const askerFamilyId = input.senderFamilyId ?? input.coveringFamilyId;
  return takeGroupExperienceTurn(
    {
      chatId: input.chatId,
      familyId: input.coveringFamilyId,
      senderHandle: input.senderHandle,
      senderUserId,
      senderName: await senderNameOf(ports.database, senderUserId),
      senderFamilyId: input.senderFamilyId ?? null,
      text: input.text,
      language: 'en',
      timeZone: await knownHouseholdTimezone(ports.database, askerFamilyId),
      now: ports.now,
    },
    {
      database: ports.database,
      reader: ports.reader,
      composer: ports.composer,
      send: ports.send,
      pollCard: postgresExperiencePollCard(ports.database),
      settleCalendar: calendarSettle(ports, input.chatId),
      sendOneToOne:
        ports.sendOneToOne ?? productionOneToOne(ports.database, ports.now, ports.oneToOne),
      privateSlices: async (familyIds) => {
        const out = [];
        for (const familyId of familyIds) {
          const { slice } = await readFamilySliceForAudience(ports.database, {
            chatId: input.chatId,
            dataFamilyId: familyId,
            audience: familyId,
          });
          out.push(slice);
        }
        return out;
      },
    },
  );
}

export function groupExperienceTakesTheTurn(
  result: GroupExperienceTurnOutcome,
): result is Extract<GroupExperienceTurnOutcome, { handled: true }> {
  return result.handled;
}

export async function considerGroupExperiencePollVote(
  ports: GroupExperienceInboundPorts,
  input: {
    chatId: string;
    senderHandle: string;
    senderUserId?: string | null;
    optionId: string;
    event: 'added' | 'removed';
  },
): Promise<GroupExperienceTurnOutcome | { handled: false }> {
  if (!groupPollsEnabled()) return { handled: false };
  if (input.event !== 'added') return { handled: false };
  const option = await lookupLinqPollOption(ports.database, input.optionId);
  if (!option || option.chatId !== input.chatId || !isGroupExperiencePollKind(option.pollKind)) {
    return { handled: false };
  }
  const store = createPostgresGroupExperienceStore(ports.database);
  const plans = createPostgresGroupPlanRsvpStore(ports.database);
  const senderUserId = input.senderUserId ?? null;
  const senderName = await senderNameOf(ports.database, senderUserId);
  const memberKey = await senderMemberKey(
    { handle: input.senderHandle, name: senderName },
    async () => [],
  );

  if (option.pollKind === 'group_rsvp' && option.choiceValue && option.subjectKey) {
    const response = option.choiceValue;
    if (response !== 'yes' && response !== 'no' && response !== 'maybe') return { handled: false };
    await plans.upsertRsvp({
      planId: option.subjectKey,
      memberKey,
      displayName: senderName || 'someone',
      householdLabel: null,
      userId: senderUserId,
      haleCustomer: !!senderUserId,
      response,
      headcount: 1,
      source: 'text',
      coversKeys: [],
      verbatim: option.text,
      now: ports.now,
    });
    await calendarSettle(
      ports,
      input.chatId,
    )({
      planId: option.subjectKey,
      userId: senderUserId,
      memberKey,
      displayName: senderName || 'someone',
      response,
      parentWords: null,
    });
    return { handled: true, outcome: 'group_experience_recorded', count: 'intake' };
  }

  if (option.pollKind === 'group_time' && option.choiceValue && option.subjectKey) {
    const live = await store.loadLiveBySubject(input.chatId, 'time_poll', option.subjectKey);
    if (!live) return { handled: false };
    const votes = {
      ...((live.payload.votes as Record<string, string> | undefined) ?? {}),
      [input.senderHandle]: option.choiceValue,
    };
    await store.patchPayload(live.id, { ...live.payload, votes }, ports.now);
    return { handled: true, outcome: 'group_experience_recorded', count: 'intake' };
  }

  return { handled: false };
}
