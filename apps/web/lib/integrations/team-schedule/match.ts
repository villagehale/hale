import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { ExtractedEvent, ExtractionKind, FamilyChildRef } from '~/lib/sentinel';
import { type TrustedScheduleFacts, scrubScheduleFacts } from './scrub';

/**
 * VIL-662 · model match of a scrubbed extraction onto one family_events row.
 * Candidates are filtered by calendar day only. Title Dice and keyword scans
 * stay out of this path (the existing correlate.ts matcher is a different door).
 */

export const MATCH_TEAM_SCHEDULE_SKILL = 'match-team-schedule';
export const MATCH_TEAM_SCHEDULE_TOOL = 'match';
export const MATCH_TEAM_SCHEDULE_TOOL_DESCRIPTION =
  'Match the trusted schedule facts to at most one candidate event.';
export const MATCH_TEAM_SCHEDULE_MAX_TOKENS = 512;

const MATCH_KINDS = ['cancellation', 'reschedule', 'reminder_only'] as const;
export type MatchableKind = (typeof MATCH_KINDS)[number];

export function isMatchableKind(kind: ExtractionKind): kind is MatchableKind {
  return (MATCH_KINDS as readonly string[]).includes(kind);
}

export const MATCH_CHANGES = ['time', 'location', 'both', 'cancel', 'none'] as const;
export type MatchChange = (typeof MATCH_CHANGES)[number];

export interface ScheduleCandidate {
  id: string;
  title: string;
  kid: string | null;
  startsAt: string;
  endsAt: string | null;
  place: string | null;
  childId: string | null;
}

export interface ScheduleMatch {
  eventId: string | null;
  change: MatchChange;
  newStartsAt: string | null;
  newLocation: string | null;
}

export const MATCH_TEAM_SCHEDULE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    eventId: { type: ['string', 'null'] },
    change: { type: 'string', enum: [...MATCH_CHANGES] },
    newStartsAt: { type: ['string', 'null'] },
    newLocation: { type: ['string', 'null'] },
  },
  required: ['eventId', 'change'],
} as const;

const EMPTY_MATCH: ScheduleMatch = {
  eventId: null,
  change: 'none',
  newStartsAt: null,
  newLocation: null,
};

function instant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function kidName(children: readonly FamilyChildRef[], childId: string | null): string | null {
  if (!childId) return null;
  return children.find((child) => child.id === childId)?.name ?? null;
}

/** Local calendar days around the extraction's dated instant, for candidate load. */
export function candidateDayWindow(
  event: Pick<ExtractedEvent, 'originalTime' | 'newTime'>,
  receivedAt: string,
  _timeZone: string,
): { from: Date; to: Date; center: Date } | null {
  const center =
    instant(event.originalTime) ?? instant(event.newTime) ?? instant(receivedAt);
  if (!center) return null;
  const padMs = 36 * 60 * 60 * 1000;
  return {
    center,
    from: new Date(center.getTime() - padMs),
    to: new Date(center.getTime() + padMs),
  };
}

export async function loadScheduleCandidates(
  database: Database,
  input: {
    familyId: string;
    event: Pick<ExtractedEvent, 'originalTime' | 'newTime'>;
    receivedAt: string;
    timeZone: string;
    children: readonly FamilyChildRef[];
  },
): Promise<ScheduleCandidate[]> {
  const window = candidateDayWindow(input.event, input.receivedAt, input.timeZone);
  if (!window) return [];
  const rows = await database
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
        eq(schema.familyEvents.familyId, input.familyId),
        householdFamilyEvent(),
        gte(schema.familyEvents.startsAt, window.from),
        lte(schema.familyEvents.startsAt, window.to),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    kid: kidName(input.children, row.childId),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    place: row.location,
    childId: row.childId,
  }));
}

export function matchTeamScheduleUserMessage(input: {
  kind: MatchableKind;
  facts: TrustedScheduleFacts;
  kid: string | null;
  was: string | null;
  when: string | null;
  candidates: readonly ScheduleCandidate[];
}): string {
  return JSON.stringify({
    kind: input.kind,
    team: input.facts.team,
    kid: input.kid,
    was: input.was,
    when: input.when,
    place: input.facts.place,
    candidates: input.candidates.map((row) => ({
      id: row.id,
      title: row.title,
      kid: row.kid,
      startsAt: row.startsAt,
      place: row.place,
    })),
  });
}

function readMatch(raw: {
  eventId: string | null;
  change: MatchChange;
  newStartsAt?: string | null;
  newLocation?: string | null;
}): ScheduleMatch {
  if (raw.change === 'none' || raw.eventId === null) return EMPTY_MATCH;
  const newStartsAt = instant(raw.newStartsAt)?.toISOString() ?? null;
  const newLocation = scrubScheduleFacts({ location: raw.newLocation }).place;
  if (raw.change === 'cancel') {
    return { eventId: raw.eventId, change: 'cancel', newStartsAt: null, newLocation: null };
  }
  if (raw.change === 'location' && newLocation === null) return EMPTY_MATCH;
  if ((raw.change === 'time' || raw.change === 'both') && newStartsAt === null) return EMPTY_MATCH;
  if (raw.change === 'both' && newLocation === null) {
    return { eventId: raw.eventId, change: 'time', newStartsAt, newLocation: null };
  }
  return {
    eventId: raw.eventId,
    change: raw.change,
    newStartsAt: raw.change === 'location' ? null : newStartsAt,
    newLocation: raw.change === 'time' ? null : newLocation,
  };
}

export async function matchTeamSchedule(
  client: AgentClient,
  input: {
    kind: MatchableKind;
    facts: TrustedScheduleFacts;
    kid: string | null;
    was: string | null;
    when: string | null;
    candidates: readonly ScheduleCandidate[];
    familyId: string;
  },
): Promise<ScheduleMatch> {
  if (input.candidates.length === 0) return EMPTY_MATCH;
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(MATCH_TEAM_SCHEDULE_SKILL);
  } catch (err) {
    console.error(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'team schedule: match skill load failed',
    );
    return EMPTY_MATCH;
  }
  try {
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: matchTeamScheduleUserMessage(input),
      toolName: MATCH_TEAM_SCHEDULE_TOOL,
      toolDescription: MATCH_TEAM_SCHEDULE_TOOL_DESCRIPTION,
      inputJsonSchema: MATCH_TEAM_SCHEDULE_TOOL_SCHEMA,
      schema: z.object({
        eventId: z.string().nullable(),
        change: z.enum(MATCH_CHANGES),
        newStartsAt: z.string().nullable().optional().default(null),
        newLocation: z.string().nullable().optional().default(null),
      }),
      maxTokens: MATCH_TEAM_SCHEDULE_MAX_TOKENS,
    });
    const allowed = new Set(input.candidates.map((row) => row.id));
    if (value.eventId !== null && !allowed.has(value.eventId)) return EMPTY_MATCH;
    return readMatch(value);
  } catch (err) {
    console.warn(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'team schedule: match failed',
    );
    return EMPTY_MATCH;
  }
}
