import { type AgentClient, SPARSE_CACHE_TTL, pickLane } from '@hale/agent';
import { type Database, familyEventForParent, schema } from '@hale/db';
import { TEENAGER_START_MONTHS } from '@hale/types';
import { and, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import { withLlmContext } from '~/lib/analytics/llm-trace';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { ExtractionKind, FamilyChildRef, SentinelClassification } from '~/lib/sentinel';
import { type EmailAlertClash, type NoticeMoment, noticeMomentAt } from './email-alert-notice';

/**
 * VIL-762 · whether two emails are one appointment, and whether that appointment
 * clashes with a commitment the family already holds.
 *
 * Code hands the model the email's facts and the commitments. The model returns
 * ids. Code checks those ids are ones it handed over. It does not compare titles,
 * places, or times to decide sameness or overlap.
 */

export const EMAIL_ALERT_APPOINTMENT_SKILL = 'email-alert-appointment';
export const EMAIL_ALERT_APPOINTMENT_TOOL = 'email_alert_appointment';
export const EMAIL_ALERT_APPOINTMENT_TOOL_DESCRIPTION =
  'Decide whether this email is an appointment already told, and whether it clashes with a known commitment.';
export const EMAIL_ALERT_APPOINTMENT_MAX_TOKENS = 400;

/** Commitments whose start sits this far from the visit are the ones the model sees. */
const COMMITMENT_WINDOW_MS = 72 * 60 * 60 * 1000;
const COMMITMENT_CAP = 8;

/** A reminder or a second receipt can be the same visit. A cancellation or a move is news. */
const REPEATABLE: ReadonlySet<ExtractionKind> = new Set([
  'new_event',
  'reminder_only',
  'booking_confirmation',
]);

export interface AppointmentCandidate {
  kind: ExtractionKind;
  title: string;
  child: string | null;
  when: NoticeMoment | null;
  ends: NoticeMoment | null;
  location: string | null;
}

export interface KnownCommitment extends EmailAlertClash {
  id: string;
}

export interface AppointmentFacts {
  email: AppointmentCandidate;
  commitments: KnownCommitment[];
}

export interface AppointmentJudgment {
  /** A commitment id that is this same visit, or null. */
  sameAs: string | null;
  /** Commitment ids this visit overlaps. Empty when it does not, or when it is the same visit. */
  clashes: string[];
}

export type AppointmentMiss = 'skill_unavailable' | 'model_failed' | 'unusable';

export type AppointmentRead =
  | { status: 'judged'; judgment: AppointmentJudgment }
  | { status: 'unjudged'; reason: AppointmentMiss };

export type AppointmentHold =
  | { outcome: 'clear' }
  | { outcome: 'same' }
  | { outcome: 'clash'; clashes: EmailAlertClash[] }
  | { outcome: 'unjudged'; reason: AppointmentMiss };

const appointmentAnswerSchema = z.object({
  reason: z.string(),
  same_as: z.string(),
  clashes_with: z.array(z.string()),
});

export const EMAIL_ALERT_APPOINTMENT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    same_as: { type: 'string' },
    clashes_with: { type: 'array', items: { type: 'string' } },
  },
  required: ['reason', 'same_as', 'clashes_with'],
} as const;

export function emailAlertAppointmentUserMessage(facts: AppointmentFacts): string {
  return JSON.stringify(facts);
}

/**
 * What the model's answer means. An id that was not handed over is unusable:
 * the call is not trusted, and nothing is sent. A cancellation or a move is
 * never "the same" visit, whatever the model called it.
 */
export function readAppointmentJudgment(
  answer: { same_as: string; clashes_with: readonly string[] },
  ids: ReadonlySet<string>,
  kind: ExtractionKind,
): AppointmentRead {
  const sameRaw = answer.same_as.trim();
  const named = sameRaw === '' ? null : sameRaw;
  if (named !== null && !ids.has(named)) return { status: 'unjudged', reason: 'unusable' };
  const clashes: string[] = [];
  for (const id of answer.clashes_with) {
    if (!ids.has(id)) return { status: 'unjudged', reason: 'unusable' };
    if (id === named || clashes.includes(id)) continue;
    clashes.push(id);
  }
  const sameAs = named !== null && REPEATABLE.has(kind) ? named : null;
  return { status: 'judged', judgment: { sameAs, clashes: sameAs === null ? clashes : [] } };
}

function childName(children: readonly FamilyChildRef[], childId: string | null): string | null {
  if (childId === null) return null;
  const child = children.find((one) => one.id === childId);
  if (child === undefined || child.ageInMonths >= TEENAGER_START_MONTHS) return null;
  const name = child.name.trim();
  return name === '' ? null : name;
}

function instantOf(iso: string | null): Date | null {
  if (iso === null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The visit's start, from the field that kind sits on. Null when the email stated none. */
export function appointmentStart(
  extraction: NonNullable<SentinelClassification['extraction']>,
): Date | null {
  const event = extraction.event;
  const iso =
    extraction.kind === 'cancellation' || extraction.kind === 'reminder_only'
      ? event.originalTime
      : (event.newTime ?? event.originalTime);
  return instantOf(iso);
}

export function appointmentCandidate(input: {
  extraction: NonNullable<SentinelClassification['extraction']>;
  children: readonly FamilyChildRef[];
  timeZone: string;
}): AppointmentCandidate {
  const { extraction, timeZone } = input;
  const start = appointmentStart(extraction);
  const end = instantOf(extraction.event.endTime ?? null);
  const hidden = extraction.teenContent;
  return {
    kind: extraction.kind,
    title: extraction.event.title.trim(),
    child: hidden ? null : childName(input.children, extraction.event.childRef),
    when: hidden || start === null ? null : noticeMomentAt(start, timeZone),
    ends: hidden || end === null ? null : noticeMomentAt(end, timeZone),
    location: hidden ? null : extraction.event.location?.trim() || null,
  };
}

function momentAt(at: Date, timeZone: string): NoticeMoment {
  return noticeMomentAt(at, timeZone);
}

function windowFor(around: Date | null, now: Date): { start: Date; end: Date } {
  if (around !== null) {
    return {
      start: new Date(around.getTime() - COMMITMENT_WINDOW_MS),
      end: new Date(around.getTime() + COMMITMENT_WINDOW_MS),
    };
  }
  return { start: now, end: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) };
}

interface Held {
  id: string;
  title: string;
  child: string | null;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
}

function kept(row: Held, timeZone: string): KnownCommitment | null {
  const title = row.title.trim();
  if (title === '') return null;
  const place = row.location?.trim() || null;
  return {
    id: row.id,
    title,
    child: row.child,
    when: momentAt(row.startsAt, timeZone),
    ends: row.endsAt === null ? null : momentAt(row.endsAt, timeZone),
    location: place === '' ? null : place,
  };
}

/**
 * Commitments Hale already holds around this visit: calendar rows, bookings, and
 * an email Hale already told the parent about that did not become one of those.
 * An offer that belongs to a booking already in the list is not a second
 * commitment. The current email is not one of them.
 */
export async function loadKnownCommitments(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    around: Date | null;
    now: Date;
    timeZone: string;
    children: readonly FamilyChildRef[];
    /** This email's provider id. Its own row, if a retry already wrote one, is not a commitment. */
    messageId: string;
  },
): Promise<KnownCommitment[]> {
  const span = windowFor(input.around, input.now);
  const [events, bookings, offers] = await Promise.all([
    database
      .select({
        id: schema.familyEvents.id,
        title: schema.familyEvents.title,
        startsAt: schema.familyEvents.startsAt,
        endsAt: schema.familyEvents.endsAt,
        location: schema.familyEvents.location,
        childId: schema.familyEvents.childId,
        calendarStanding: schema.familyEvents.calendarStanding,
      })
      .from(schema.familyEvents)
      .where(
        and(
          eq(schema.familyEvents.familyId, input.familyId),
          familyEventForParent(input.parentUserId),
          gte(schema.familyEvents.startsAt, span.start),
          lt(schema.familyEvents.startsAt, span.end),
        ),
      ),
    database
      .select({
        id: schema.activityBookings.id,
        title: schema.activityBookings.title,
        startsAt: schema.activityBookings.firstSessionAt,
        location: schema.activityBookings.location,
        address: schema.activityBookings.address,
        messageId: schema.activityBookings.messageId,
        integrationId: schema.activityBookings.integrationId,
        cancelledAt: schema.activityBookings.cancelledAt,
      })
      .from(schema.activityBookings)
      .where(
        and(
          eq(schema.activityBookings.familyId, input.familyId),
          // This parent's mailbox only. The other parent's booking is their mail.
          eq(schema.activityBookings.parentUserId, input.parentUserId),
          gte(schema.activityBookings.firstSessionAt, span.start),
          lt(schema.activityBookings.firstSessionAt, span.end),
        ),
      ),
    database
      .select({
        id: schema.emailAlertOffers.id,
        title: schema.emailAlertOffers.title,
        startsAt: schema.emailAlertOffers.startsAt,
        location: schema.emailAlertOffers.location,
        messageId: schema.emailAlertOffers.messageId,
        integrationId: schema.emailAlertOffers.integrationId,
        eventId: schema.emailAlertOffers.eventId,
      })
      .from(schema.emailAlertOffers)
      .where(
        and(
          eq(schema.emailAlertOffers.familyId, input.familyId),
          eq(schema.emailAlertOffers.parentUserId, input.parentUserId),
          gte(schema.emailAlertOffers.startsAt, span.start),
          lt(schema.emailAlertOffers.startsAt, span.end),
        ),
      ),
  ]);

  const pair = (integrationId: string, messageId: string) => `${integrationId}\u0000${messageId}`;
  const livePairs = new Set(
    bookings
      .filter((row) => row.cancelledAt === null && row.messageId !== input.messageId)
      .map((row) => pair(row.integrationId, row.messageId)),
  );
  // A provider cancellation withdraws the offer by expiry only. The booking row
  // is the fact that the visit is off, so its offer is not still a commitment.
  const cancelledPairs = new Set(
    bookings
      .filter((row) => row.cancelledAt !== null)
      .map((row) => pair(row.integrationId, row.messageId)),
  );
  const held: Held[] = [];
  for (const row of events) {
    // An unanswered invite is not a commitment. A household row has no standing.
    if (row.calendarStanding === 'invited') continue;
    const child = input.children.find((one) => one.id === row.childId);
    // A 13+ child's title, time and place stay out of a parent text.
    if (child !== undefined && child.ageInMonths >= TEENAGER_START_MONTHS) continue;
    held.push({
      id: row.id,
      title: row.title,
      child: childName(input.children, row.childId),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      location: row.location,
    });
  }
  for (const row of bookings) {
    if (row.cancelledAt !== null || row.messageId === input.messageId) continue;
    held.push({
      id: row.id,
      title: row.title,
      child: null,
      startsAt: row.startsAt,
      endsAt: null,
      location: row.location?.trim() || row.address?.trim() || null,
    });
  }
  for (const row of offers) {
    if (row.messageId === input.messageId || row.eventId !== null) continue;
    const key = pair(row.integrationId, row.messageId);
    if (livePairs.has(key) || cancelledPairs.has(key)) continue;
    // A declined offer is a no to the calendar add, not to the appointment.
    held.push({
      id: row.id,
      title: row.title,
      child: null,
      startsAt: row.startsAt,
      endsAt: null,
      location: row.location,
    });
  }

  const anchor = (input.around ?? input.now).getTime();
  return held
    .map((row) => ({ row, at: row.startsAt.getTime() }))
    .sort((a, b) => Math.abs(a.at - anchor) - Math.abs(b.at - anchor) || a.at - b.at)
    .flatMap(({ row }) => {
      const commitment = kept(row, input.timeZone);
      return commitment === null ? [] : [commitment];
    })
    .slice(0, COMMITMENT_CAP);
}

export async function composeAppointmentJudgment(
  client: AgentClient,
  facts: AppointmentFacts,
  familyId: string,
  kind: ExtractionKind,
): Promise<AppointmentRead> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(EMAIL_ALERT_APPOINTMENT_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'email alert: appointment skill load failed',
    );
    return { status: 'unjudged', reason: 'skill_unavailable' };
  }
  try {
    const { value } = await withLlmContext({ stage: 'notice' }, () =>
      forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        cacheTtl: SPARSE_CACHE_TTL,
        userMessage: emailAlertAppointmentUserMessage(facts),
        toolName: EMAIL_ALERT_APPOINTMENT_TOOL,
        toolDescription: EMAIL_ALERT_APPOINTMENT_TOOL_DESCRIPTION,
        inputJsonSchema: EMAIL_ALERT_APPOINTMENT_TOOL_SCHEMA,
        schema: appointmentAnswerSchema,
        maxTokens: EMAIL_ALERT_APPOINTMENT_MAX_TOKENS,
      }),
    );
    return readAppointmentJudgment(
      value,
      new Set(facts.commitments.map((commitment) => commitment.id)),
      kind,
    );
  } catch (err) {
    console.warn(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'email alert: appointment read failed',
    );
    return { status: 'unjudged', reason: 'model_failed' };
  }
}

export async function judgeKnownAppointment(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    messageId: string;
    timeZone: string;
    now: Date;
    extraction: NonNullable<SentinelClassification['extraction']>;
    children: readonly FamilyChildRef[];
  },
  judge: ((facts: AppointmentFacts, familyId: string) => Promise<AppointmentRead>) | undefined,
): Promise<AppointmentHold> {
  const candidate = appointmentCandidate(input);
  const commitments = await loadKnownCommitments(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    around: appointmentStart(input.extraction),
    now: input.now,
    timeZone: input.timeZone,
    children: input.children,
    messageId: input.messageId,
  });
  if (commitments.length === 0) return { outcome: 'clear' };
  if (judge === undefined) return { outcome: 'unjudged', reason: 'skill_unavailable' };
  let read: AppointmentRead;
  try {
    read = await judge({ email: candidate, commitments }, input.familyId);
  } catch (err) {
    console.warn(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'email alert: appointment judge threw',
    );
    return { outcome: 'unjudged', reason: 'model_failed' };
  }
  if (read.status !== 'judged') return { outcome: 'unjudged', reason: read.reason };
  const ids = new Set(commitments.map((commitment) => commitment.id));
  if (
    (read.judgment.sameAs !== null && !ids.has(read.judgment.sameAs)) ||
    read.judgment.clashes.some((id) => !ids.has(id))
  ) {
    return { outcome: 'unjudged', reason: 'unusable' };
  }
  if (read.judgment.sameAs !== null) return { outcome: 'same' };
  if (read.judgment.clashes.length === 0) return { outcome: 'clear' };
  const byId = new Map(commitments.map((commitment) => [commitment.id, commitment]));
  const clashes: EmailAlertClash[] = [];
  for (const id of read.judgment.clashes) {
    const commitment = byId.get(id);
    if (commitment === undefined) return { outcome: 'unjudged', reason: 'unusable' };
    const { id: _id, ...clash } = commitment;
    clashes.push(clash);
  }
  return { outcome: 'clash', clashes };
}
