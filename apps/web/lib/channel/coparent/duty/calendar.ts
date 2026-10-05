import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { classifyKidCalendarItem, splitKidEvent } from '~/lib/channel/linq/kid-event';
import {
  type DutyCopyLanguage,
  dutyCopyLocked,
  dutyTitleMayBeSpoken,
  spokenFirstName,
} from './copy';
import { coparentDutyMemoryEnabled } from './flag';
import type { DutyState } from './model';

/**
 * VIL-383 — duty on Hale's own `family_events`, and on the ICS feed.
 *
 * The subscription feed is not an iTIP REQUEST. RFC 5545 ATTENDEE would
 * claim an invitee, and ORGANIZER on invites is already Hale. DESCRIPTION
 * (§3.8.1.5) is the field that can say who owns a kid event. It is omitted
 * when unset.
 *
 * Google Calendar is not written. This module does not import the calendar
 * client. The Google connection stays read-only.
 */

const MATCH_MS = 60 * 1000;

export type DutyProjection =
  | { status: 'updated'; eventId: string }
  | { status: 'cleared'; eventId: string }
  | {
      status: 'skipped';
      reason: 'flag_off' | 'non_kid_title' | 'no_family_event' | 'ambiguous';
    };

export function dutyStartInstant(subjectKey: string, factKey: string): Date | null {
  const keys = [subjectKey, factKey];
  const wrapped = /^duty\/([^/]+)\//.exec(factKey);
  if (wrapped?.[1]) {
    try {
      keys.push(decodeURIComponent(wrapped[1]));
    } catch {
      keys.push(wrapped[1]);
    }
  }
  for (const key of keys) {
    const match = /^who-takes\/([^/]+)\//.exec(key);
    if (!match?.[1]) continue;
    const instant = new Date(match[1]);
    if (!Number.isNaN(instant.getTime())) return instant;
  }
  return null;
}

function ownerFields(
  state: DutyState,
  parentName: string | null,
): { userId: string | null; label: string | null; kind: 'parent' | 'named' | 'both' } | null {
  if (state.status !== 'confirmed' || !state.owner) return null;
  if (state.owner.kind === 'both_parents') return { userId: null, label: null, kind: 'both' };
  if (state.owner.kind === 'named') {
    return { userId: null, label: spokenFirstName(state.owner.name), kind: 'named' };
  }
  return {
    userId: state.owner.userId,
    label: spokenFirstName(parentName),
    kind: 'parent',
  };
}

/**
 * Overwrite the live duty columns on the matching family event. A previous
 * owner stays in `audit_log`. The event row is not deleted.
 */
export async function projectDutyOnFamilyEvent(
  database: Database,
  input: {
    familyId: string;
    actorUserId: string;
    factKey: string;
    subjectKey: string;
    state: DutyState;
    now: Date;
  },
): Promise<DutyProjection> {
  if (!coparentDutyMemoryEnabled()) return { status: 'skipped', reason: 'flag_off' };
  if (typeof database.select !== 'function')
    return { status: 'skipped', reason: 'no_family_event' };

  const children = await database
    .select({ name: schema.children.name, familyId: schema.children.familyId })
    .from(schema.children)
    .where(eq(schema.children.familyId, input.familyId));
  const childNames = children
    .filter((row) => row.familyId === input.familyId && row.name)
    .map((row) => row.name);

  const rows = await database
    .select({
      id: schema.familyEvents.id,
      familyId: schema.familyEvents.familyId,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      deletedAt: schema.familyEvents.deletedAt,
      dutyOwnerUserId: schema.familyEvents.dutyOwnerUserId,
      dutyOwnerLabel: schema.familyEvents.dutyOwnerLabel,
      dutyOwnerKind: schema.familyEvents.dutyOwnerKind,
      dutyRole: schema.familyEvents.dutyRole,
      dutyFactKey: schema.familyEvents.dutyFactKey,
    })
    .from(schema.familyEvents)
    .where(
      and(eq(schema.familyEvents.familyId, input.familyId), isNull(schema.familyEvents.deletedAt)),
    );

  const live = rows.filter((row) => row.familyId === input.familyId && row.deletedAt === null);
  const byFact = live.filter((row) => row.dutyFactKey === input.factKey);
  const start = dutyStartInstant(input.subjectKey, input.factKey);
  const byTime = start
    ? live.filter((row) => Math.abs(row.startsAt.getTime() - start.getTime()) <= MATCH_MS)
    : [];
  const pool = byFact.length > 0 ? byFact : byTime;
  if (pool.length === 0) return { status: 'skipped', reason: 'no_family_event' };
  if (pool.length > 1) return { status: 'skipped', reason: 'ambiguous' };
  const event = pool[0];
  if (!event) return { status: 'skipped', reason: 'no_family_event' };
  if (!classifyKidCalendarItem({ title: event.title, childNames })) {
    return { status: 'skipped', reason: 'non_kid_title' };
  }

  let parentName: string | null = null;
  const dutyOwner = input.state.owner;
  if (dutyOwner && dutyOwner.kind === 'parent') {
    const [user] = await database
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, dutyOwner.userId))
      .limit(1);
    parentName = user?.name ?? null;
  }
  const owner = ownerFields(input.state, parentName);
  const next = owner
    ? {
        dutyOwnerUserId: owner.userId,
        dutyOwnerLabel: owner.label,
        dutyOwnerKind: owner.kind,
        dutyRole: input.state.role,
        dutyFactKey: input.factKey,
        dutySetAt: input.now,
      }
    : {
        dutyOwnerUserId: null,
        dutyOwnerLabel: null,
        dutyOwnerKind: null,
        dutyRole: null,
        dutyFactKey: null,
        dutySetAt: null,
      };

  await database
    .update(schema.familyEvents)
    .set(next)
    .where(
      and(eq(schema.familyEvents.id, event.id), eq(schema.familyEvents.familyId, input.familyId)),
    );
  const audit = {
    familyId: input.familyId,
    actor: input.actorUserId,
    targetTable: 'family_events' as const,
    targetId: event.id,
    before: {
      dutyOwnerUserId: event.dutyOwnerUserId,
      dutyOwnerLabel: event.dutyOwnerLabel,
      dutyOwnerKind: event.dutyOwnerKind,
      dutyRole: event.dutyRole,
      dutyFactKey: event.dutyFactKey,
    },
    after: next,
  };
  if (owner) {
    await database.insert(schema.auditLog).values({
      ...audit,
      actionTaken: 'duty_calendar_projected',
    });
  } else {
    await database.insert(schema.auditLog).values({
      ...audit,
      actionTaken: 'duty_calendar_cleared',
    });
  }
  return owner
    ? { status: 'updated', eventId: event.id }
    : { status: 'cleared', eventId: event.id };
}

/**
 * DESCRIPTION for one feed event. Null leaves the VEVENT without one.
 *
 * A DATA VALUE, not a sentence: the owner's first name, exactly as a parent agreed to it.
 * The feed is rendered synchronously on every calendar poll with no model in the path,
 * so this is the one duty surface that stays fixed (VIL-413 / VIL-417) — and what stays
 * fixed is a name, which code can honestly supply, rather than the owner sentence and
 * "Say so here if that changes." it used to carry. The title beside it already says whose
 * event it is; this says who has it.
 */
export function dutyFeedDescription(input: {
  title: string;
  startsAt: Date;
  ownerLabel: string | null;
  ownerKind: string | null;
  childName: string | null;
  teen: boolean;
  timeZone: string;
  language: DutyCopyLanguage;
}): string | null {
  if (!coparentDutyMemoryEnabled() || !dutyCopyLocked()) return null;
  if (input.teen) return null;
  if (input.ownerKind !== 'parent' && input.ownerKind !== 'named') return null;
  if (!dutyTitleMayBeSpoken(input.title)) return null;
  const name = spokenFirstName(input.ownerLabel);
  if (!name) return null;
  const names = input.childName ? [input.childName] : [];
  const split = splitKidEvent(input.title, names);
  const kid = split?.kid ?? input.childName;
  const event = split?.event ?? input.title;
  if (!kid) return null;
  const spokenEvent = dutyTitleMayBeSpoken(event) ? event : input.title;
  if (!dutyTitleMayBeSpoken(spokenEvent)) return null;
  return name;
}
