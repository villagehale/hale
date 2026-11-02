import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { createFamilyEventsCopyStore } from '../group-plan-invites';
import type { LinqTapback } from '../transport';

/**
 * VIL-503 — consent, then one household's calendar.
 *
 * The model reads whether a message answers the open ask, and writes the ask
 * and the confirmation. Code never matches the parent's words. The calendar
 * copy uses the same per-family key as a group-plan placement, so a second
 * OK cannot place a second row, and another family's id is a different key.
 */

export const GROUP_PLAN_RSVP_CALENDAR_READ_SKILL = 'group-plan-rsvp-calendar-read';
export const GROUP_PLAN_RSVP_CALENDAR_VOICE_SKILL = 'group-plan-rsvp-calendar-voice';

const PARENT_ROLES = ['primary_parent', 'co_parent'] as const;

export type CalendarConsentDecision = 'ok' | 'decline' | 'reopen' | 'not_this';

export interface CalendarAskFacts {
  title: string;
  startsAt: string | null;
  location: string | null;
  displayName: string;
  householdLabel: string | null;
}

export interface CalendarConsentReadInput {
  text: string;
  tapback: LinqTapback | null;
  senderName: string | null;
  /** `asked` is an open OK. `declined` is closed unless they bring it up again. */
  consent: 'asked' | 'declined';
  ask: CalendarAskFacts;
}

export interface CalendarConsentReading {
  decision: CalendarConsentDecision;
  confidence: 'high' | 'low';
}

export interface CalendarConsentReader {
  read(input: CalendarConsentReadInput): Promise<CalendarConsentReading | null>;
}

const consentSchema = z.object({
  decision: z.enum(['ok', 'decline', 'reopen', 'not_this']),
  confidence: z.enum(['high', 'low']),
});

export const CALENDAR_CONSENT_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['ok', 'decline', 'reopen', 'not_this'] },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: ['decision', 'confidence'],
} as const;

export const CALENDAR_CONSENT_MAX_TOKENS = 200;

/** The user-turn payload. Facts only — no suggested reply. */
export function calendarConsentUserMessage(input: CalendarConsentReadInput): string {
  return JSON.stringify({
    text: input.text,
    tapback: input.tapback,
    senderName: input.senderName,
    consent: input.consent,
    ask: {
      title: input.ask.title,
      startsAt: input.ask.startsAt,
      location: input.ask.location,
      displayName: input.ask.displayName,
      householdLabel: input.ask.householdLabel,
    },
  });
}

export function createCalendarConsentReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): CalendarConsentReader {
  const once = async (input: CalendarConsentReadInput): Promise<CalendarConsentReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill(GROUP_PLAN_RSVP_CALENDAR_READ_SKILL);
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: calendarConsentUserMessage(input),
      toolName: 'group_plan_calendar_consent',
      toolDescription: 'Return whether this message answers the open calendar ask.',
      inputJsonSchema: CALENDAR_CONSENT_TOOL_SCHEMA,
      schema: consentSchema,
      maxTokens: CALENDAR_CONSENT_MAX_TOKENS,
    });
    return value;
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group plan calendar consent: read failed',
          );
        }
      }
      console.error(
        { outcome: 'group_plan_calendar_consent_unread' },
        'group plan calendar consent: no state change',
      );
      return null;
    },
  };
}

let sharedReader: CalendarConsentReader | null = null;

export function sharedCalendarConsentReader(): CalendarConsentReader {
  sharedReader ??= createCalendarConsentReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return sharedReader;
}

export type GroupPlanCalendarVoiceKind = 'calendar_ask' | 'calendar_written' | 'calendar_removed';

/** A private line to one parent. There is no group chat id on this send. */
export type CalendarPrivateKind = GroupPlanCalendarVoiceKind;

export interface CalendarPrivateLine {
  planId: string;
  familyId: string;
  userId: string | null;
  text: string;
  kind: CalendarPrivateKind;
}

export interface CalendarPrivateSender {
  send(
    line: CalendarPrivateLine,
  ): Promise<
    | { status: 'sent'; providerMessageId: string | null }
    | { status: 'skipped'; reason: 'not_sent' | 'no_parent' }
  >;
}

export interface GroupPlanCalendarLineInput {
  skill: typeof GROUP_PLAN_RSVP_CALENDAR_VOICE_SKILL;
  kind: GroupPlanCalendarVoiceKind;
  language: ReplyLanguage;
  facts: CalendarAskFacts;
  questions: 0 | 1;
}

export function groupPlanCalendarLineInput(input: {
  kind: GroupPlanCalendarVoiceKind;
  language: ReplyLanguage;
  facts: CalendarAskFacts;
}): GroupPlanCalendarLineInput {
  return {
    skill: GROUP_PLAN_RSVP_CALENDAR_VOICE_SKILL,
    kind: input.kind,
    language: input.language,
    facts: input.facts,
    questions: input.kind === 'calendar_ask' ? 1 : 0,
  };
}

export type HouseholdResolution =
  | { status: 'one'; familyId: string }
  | { status: 'none' }
  | { status: 'ambiguous' };

export interface GroupPlanHouseholdResolver {
  resolve(input: { chatId: string; userId: string | null }): Promise<HouseholdResolution>;
}

/**
 * The household whose calendar an OK may touch.
 *
 * A parent of the family that claimed the chat, or a parent of another family
 * with a live consented join. One match. Zero is none. Two is ambiguous, and
 * neither calendar is written. A caregiver, a nanny, or someone with no Hale
 * family is none.
 */
export function postgresGroupPlanHouseholds(database: Database): GroupPlanHouseholdResolver {
  return {
    async resolve(input) {
      if (!input.userId) return { status: 'none' };
      const memberships = await database
        .select({
          familyId: schema.familyMembers.familyId,
          role: schema.familyMembers.role,
        })
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.userId, input.userId));
      const parentFamilies = memberships
        .filter((row) => (PARENT_ROLES as readonly string[]).includes(row.role))
        .map((row) => row.familyId);
      if (parentFamilies.length === 0) return { status: 'none' };

      const [covering] = await database
        .select({ id: schema.families.id })
        .from(schema.families)
        .where(eq(schema.families.linqGroupChatId, input.chatId))
        .limit(1);
      const joined = await consentedJoinFamilyIds(database, input.chatId);
      const seated = await liveSeatFamilies(database, input.chatId, input.userId);
      const eligible = parentFamilies.filter(
        (id) => seated.has(id) && (id === covering?.id || joined.has(id)),
      );
      if (eligible.length === 1) {
        const familyId = eligible[0];
        return familyId ? { status: 'one', familyId } : { status: 'none' };
      }
      if (eligible.length === 0) return { status: 'none' };
      return { status: 'ambiguous' };
    },
  };
}

/** A parent who has left the chat is not seated, so they cannot OK a calendar write. */
async function liveSeatFamilies(
  database: Database,
  chatId: string,
  userId: string,
): Promise<Set<string>> {
  const groupSeats = await database
    .select({ familyId: schema.linqGroupMembers.familyId })
    .from(schema.linqGroupMembers)
    .where(
      and(
        eq(schema.linqGroupMembers.chatId, chatId),
        eq(schema.linqGroupMembers.userId, userId),
        isNull(schema.linqGroupMembers.removedAt),
      ),
    );
  const sharedSeats = await database
    .select({ familyId: schema.linqMultiFamilyMembers.familyId })
    .from(schema.linqMultiFamilyMembers)
    .where(
      and(
        eq(schema.linqMultiFamilyMembers.chatId, chatId),
        eq(schema.linqMultiFamilyMembers.userId, userId),
        isNull(schema.linqMultiFamilyMembers.removedAt),
      ),
    );
  return new Set([...groupSeats, ...sharedSeats].map((row) => row.familyId));
}

async function consentedJoinFamilyIds(database: Database, chatId: string): Promise<Set<string>> {
  const joins = await database
    .select({
      familyId: schema.linqMultiFamilyJoins.familyId,
      consentRecordId: schema.linqMultiFamilyJoins.consentRecordId,
    })
    .from(schema.linqMultiFamilyJoins)
    .where(
      and(
        eq(schema.linqMultiFamilyJoins.chatId, chatId),
        isNull(schema.linqMultiFamilyJoins.leftAt),
      ),
    );
  const ids = new Set<string>();
  for (const join of joins) {
    if (!join.consentRecordId) continue;
    const [consent] = await database
      .select({
        familyId: schema.consentRecords.familyId,
        granted: schema.consentRecords.granted,
        revokedAt: schema.consentRecords.revokedAt,
        consentType: schema.consentRecords.consentType,
        consentScope: schema.consentRecords.consentScope,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.id, join.consentRecordId))
      .limit(1);
    if (
      consent &&
      consent.familyId === join.familyId &&
      consent.granted === true &&
      consent.revokedAt == null &&
      consent.consentType === 'multi_family_group' &&
      consent.consentScope === chatId
    ) {
      ids.add(join.familyId);
    }
  }
  return ids;
}

export interface GroupPlanCalendarWrite {
  planId: string;
  chatId: string;
  familyId: string;
  title: string;
  startsAt: Date;
  location: string | null;
}

export interface GroupPlanCalendarWriter {
  write(
    input: GroupPlanCalendarWrite,
  ): Promise<
    | { status: 'written'; familyEventId: string }
    | { status: 'unchanged'; familyEventId: string }
    | { status: 'failed' }
  >;
  /**
   * Soft-deletes the copy Hale placed for this plan and family. A row the
   * parent added themselves has no group-plan key and is left alone.
   */
  remove(input: {
    planId: string;
    familyId: string;
  }): Promise<
    { status: 'removed'; familyEventId: string } | { status: 'none' } | { status: 'failed' }
  >;
}

/** One family_events copy for this family. The key is (plan, family). */
export function postgresGroupPlanCalendarWriter(database: Database): GroupPlanCalendarWriter {
  const copies = createFamilyEventsCopyStore(database);
  return {
    async write(input) {
      try {
        const result = await copies.upsertCopy(
          {
            groupPlanId: input.planId,
            chatId: input.chatId,
            title: input.title,
            startsAt: input.startsAt,
            endsAt: null,
            location: input.location,
            cancelled: false,
          },
          input.familyId,
        );
        return {
          status: result.status === 'written' ? 'written' : 'unchanged',
          familyEventId: result.familyEventId,
        };
      } catch (err) {
        console.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'group plan calendar: write failed',
        );
        return { status: 'failed' };
      }
    },
    async remove(input) {
      try {
        const familyEventId = await copies.cancelCopy(
          {
            groupPlanId: input.planId,
            chatId: '',
            title: '',
            startsAt: new Date(0),
            endsAt: null,
            location: null,
            cancelled: true,
          },
          input.familyId,
        );
        return familyEventId ? { status: 'removed', familyEventId } : { status: 'none' };
      } catch (err) {
        console.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'group plan calendar: remove failed',
        );
        return { status: 'failed' };
      }
    },
  };
}
