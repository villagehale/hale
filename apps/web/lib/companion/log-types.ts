import { z } from 'zod';

/**
 * Quick-log episode shapes shared by the server action (log.ts) and the client
 * form (quick-log.tsx). Kept out of the 'use server' module because a server
 * module may only export async functions — constants, schemas, and types live
 * here so the client can import them without pulling server code over the wire.
 */

export const FEED_EPISODE = 'feed';
export const NAP_EPISODE = 'nap';
export const DIAPER_EPISODE = 'diaper';
export const MILESTONE_EPISODE = 'milestone';
/** A logged growth measurement (weight / height / head circumference). A raw data
 * point only — NO percentile or WHO comparison is ever derived (that would be
 * fabricated medical framing); the companion shows the plain series alone. */
export const MEASUREMENT_EPISODE = 'measurement';
export const BOOKING_EPISODE = 'booking_requested';
/** A completed curated health item (a checkup / immunization set the parent
 * confirms is done). Distinct from the free-text quick-log kinds so the companion
 * read can join it back to the curated schedule by payload.healthKey. */
export const HEALTH_DONE_EPISODE = 'health_done';

/** A feed's kind, surfaced in the timeline. 'unspecified' is the default when a
 * parent doesn't pick one (kept out of the summary). */
export const FEED_KINDS = ['bottle', 'breast', 'solid'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** A feed's QUALITATIVE amount — the design's "How much" chips (A little / Half /
 * Most of it / All of it). An additive alternative to a numeric amountMl: a parent
 * logs what they actually observed ("most of it") without inventing a millilitre
 * figure. Stored verbatim; the summary words it (buildEpisodeInsert). */
export const FEED_AMOUNTS = ['little', 'half', 'most', 'all'] as const;
export type FeedAmount = (typeof FEED_AMOUNTS)[number];

/** A diaper's kind — the one required datum of a diaper log (the prototype's
 * Log-diaper chips). 'dry' is a real logged state (checked, still dry), not a
 * missing value. */
export const DIAPER_KINDS = ['wet', 'dirty', 'mixed', 'dry'] as const;
export type DiaperKind = (typeof DIAPER_KINDS)[number];

/** The kinds of growth measurement a parent may log. Each has ONE fixed unit and a
 * sane upper bound (a child's real range — a mistyped value is rejected, never
 * charted). Weight is kg; height and head circumference are cm. */
export const MEASURE_KINDS = ['weight', 'height', 'head'] as const;
export type MeasureKind = (typeof MEASURE_KINDS)[number];

/** Fixed unit + human label per measure kind — the unit is NEVER user-chosen (a
 * weight is always kg), so the summary and series can't mix units. */
export const MEASURE_META: Record<MeasureKind, { unit: 'kg' | 'cm'; label: string; max: number }> =
  {
    weight: { unit: 'kg', label: 'Weight', max: 40 },
    height: { unit: 'cm', label: 'Height', max: 220 },
    head: { unit: 'cm', label: 'Head', max: 70 },
  };

/** How far in the future a logged time may be (small clock-skew tolerance) and
 * how far back it may reach. A quick-log is a recent household event, so a year
 * back is generous while still rejecting an absurd / mistyped date. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_BACKDATE_MS = 365 * 24 * 60 * 60 * 1000;

/** An optional logged time: an ISO/datetime-local string, validated to a real
 * date. Range bounds are checked at the action boundary against the request
 * clock (validateOccurredAt), since "now" is only authoritative there. */
const occurredAtField = z.string().trim().min(1).datetime({ offset: true }).optional();

// A feed carries EITHER a numeric amountMl OR a qualitative feedAmount. Both are
// OPTIONAL here so feedSchema stays a plain ZodObject (a valid member of the
// discriminated union, like napSchema). The "at least one amount" rule is enforced at
// the action boundary by resolveFeed — the same place the nap window / occurredAt
// range rules live — never by a schema .refine (which would break the union).
export const feedSchema = z.object({
  kind: z.literal(FEED_EPISODE),
  childId: z.string().uuid(),
  amountMl: z.coerce.number().positive().max(2000).optional(),
  feedAmount: z.enum(FEED_AMOUNTS).optional(),
  feedKind: z.enum(FEED_KINDS).optional(),
  note: z.string().trim().max(280).optional(),
  occurredAt: occurredAtField,
});

/** A nap's bounds: an ISO/datetime string with offset, validated to a real date
 * (range-checked at the action boundary via resolveNapWindow). Optional — a plain
 * durationMin entry omits both. */
const napBoundField = z.string().trim().min(1).datetime({ offset: true }).optional();

// Stays a plain ZodObject (no .refine) so it remains a valid member of the
// quickLogSchema discriminated union. The cross-field rules — a window needs both
// bounds, and a nap needs EITHER a duration or a window — are enforced at the
// action boundary (resolveNapWindow), the same place occurredAt is range-checked.
export const napSchema = z.object({
  kind: z.literal(NAP_EPISODE),
  childId: z.string().uuid(),
  /** Optional once a start/end pair is given — the server derives the duration
   * from the window. Still accepted directly for the plain "how long" entry. */
  durationMin: z.coerce.number().positive().max(1440).optional(),
  startAt: napBoundField,
  endAt: napBoundField,
  note: z.string().trim().max(280).optional(),
  occurredAt: occurredAtField,
});

/**
 * A diaper quick-log. `diaperKind` (wet/dirty/mixed/dry) is the one required datum;
 * there is no numeric field and no boundary rule (unlike nap/measurement), so this
 * plain ZodObject fully validates a diaper on its own while staying a valid member
 * of the quickLogSchema discriminated union. The optional note + occurredAt ride
 * along like every other quick-log.
 */
export const diaperSchema = z.object({
  kind: z.literal(DIAPER_EPISODE),
  childId: z.string().uuid(),
  diaperKind: z.enum(DIAPER_KINDS),
  note: z.string().trim().max(280).optional(),
  occurredAt: occurredAtField,
});

export const milestoneSchema = z.object({
  kind: z.literal(MILESTONE_EPISODE),
  childId: z.string().uuid(),
  milestone: z.string().trim().min(1).max(280),
  note: z.string().trim().max(280).optional(),
  occurredAt: occurredAtField,
});

/**
 * A growth measurement quick-log. `measureKind` picks the metric (its unit is
 * fixed, never sent by the client) and `value` is a positive number. The generous
 * `.max` here only rejects a wildly-out-of-range value at the schema; the per-kind
 * ceiling (MEASURE_META.max) is enforced at the boundary by resolveMeasurement,
 * mirroring how the nap window / occurredAt range rules live at the action boundary
 * so this stays a plain ZodObject (a valid member of quickLogSchema).
 */
export const measurementSchema = z.object({
  kind: z.literal(MEASUREMENT_EPISODE),
  childId: z.string().uuid(),
  measureKind: z.enum(MEASURE_KINDS),
  value: z.coerce.number().positive().max(500),
  note: z.string().trim().max(280).optional(),
  occurredAt: occurredAtField,
});

export const quickLogSchema = z.discriminatedUnion('kind', [
  feedSchema,
  napSchema,
  diaperSchema,
  milestoneSchema,
  measurementSchema,
]);

export type QuickLogInput = z.infer<typeof quickLogSchema>;

/**
 * Bounds-checks a measurement's value against the per-kind ceiling (MEASURE_META),
 * at the boundary — like resolveNap / resolveOccurredAt — so measurementSchema can
 * stay a plain ZodObject in the discriminated union. A weight over 40 kg or a head
 * over 70 cm is a mistype, not a real reading, and is rejected rather than charted.
 */
export function resolveMeasurement(
  measureKind: MeasureKind,
  value: number,
): { ok: true } | { ok: false; error: string } {
  if (value > MEASURE_META[measureKind].max) {
    return { ok: false, error: 'that reading looks too high — check the value' };
  }
  return { ok: true };
}

/**
 * Resolves and bounds-checks an optional logged time against the request clock.
 * Returns the chosen Date (defaulting to `now` when omitted), or an error string
 * when the time is unparseable, in the future beyond a small skew, or absurdly
 * old. Lives here so client and server agree on the rule.
 */
export function resolveOccurredAt(
  occurredAt: string | undefined,
  now: Date,
): { ok: true; date: Date } | { ok: false; error: string } {
  if (occurredAt === undefined) return { ok: true, date: now };
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: 'enter a real date and time' };
  }
  const delta = date.getTime() - now.getTime();
  if (delta > MAX_FUTURE_SKEW_MS) {
    return { ok: false, error: 'that time is in the future — pick when it happened' };
  }
  if (-delta > MAX_BACKDATE_MS) {
    return { ok: false, error: 'that time is too far in the past' };
  }
  return { ok: true, date };
}

/**
 * Resolves a nap's start/end window into a whole-minute duration, or null when no
 * window was given (a plain durationMin entry). A lone bound is rejected — the
 * window needs both so a duration can be derived. Each bound gets the SAME range
 * discipline as occurredAt (resolveOccurredAt: real date, not future, not absurdly
 * old), then the end must be strictly after the start and the derived duration
 * bounded to the same 1..1440 range the direct durationMin field accepts. Lives
 * here so client and server agree on the rule.
 */
export function resolveNapWindow(
  startAt: string | undefined,
  endAt: string | undefined,
  now: Date,
): { ok: true; durationMin: number | null } | { ok: false; error: string } {
  if (startAt === undefined && endAt === undefined) return { ok: true, durationMin: null };
  if (startAt === undefined || endAt === undefined) {
    return { ok: false, error: 'a nap window needs both a start and an end' };
  }

  const start = resolveOccurredAt(startAt, now);
  if (!start.ok) return start;
  const end = resolveOccurredAt(endAt, now);
  if (!end.ok) return end;

  const spanMs = end.date.getTime() - start.date.getTime();
  if (spanMs <= 0) {
    return { ok: false, error: 'the nap end must be after its start' };
  }
  const durationMin = Math.round(spanMs / 60_000);
  if (durationMin < 1) {
    return { ok: false, error: 'that nap is too short to log' };
  }
  if (durationMin > 1440) {
    return { ok: false, error: 'that nap is longer than a day — check the times' };
  }
  return { ok: true, durationMin };
}

/** Edit of an existing logged episode from the dedicated logs view. A parent may
 * revise the two human-facing fields the list shows — the one-liner summary and
 * when it happened. id scopes the row; family scoping is enforced server-side. */
export const editEpisodeSchema = z.object({
  id: z.string().uuid(),
  summary: z.string().trim().min(1).max(280),
  occurredAt: occurredAtField,
});

/** Soft-delete of an existing logged episode. Only the row id — family scoping is
 * enforced server-side (rule #1). */
export const deleteEpisodeSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Marking a CURATED companion item done from the companion view. A done-tap is a
 * one-shot write with no free-text: the client sends the item the parent tapped
 * (identified by the curated `what`, and — for health — its stable healthKey), and
 * the server maps it to the same episode write path a quick-log uses. A milestone
 * done writes the SAME row a quick-log milestone writes (episodeType 'milestone',
 * summary = what); a health done writes a 'health_done' episode carrying the key so
 * the companion read can flip that item to done. `occurredAt` is server-clocked
 * (now) — a done-tap records "confirmed done today", not a backdated entry.
 */
export const markMilestoneDoneSchema = z.object({
  target: z.literal('milestone'),
  childId: z.string().uuid(),
  what: z.string().trim().min(1).max(280),
});

export const markHealthDoneSchema = z.object({
  target: z.literal('health'),
  childId: z.string().uuid(),
  what: z.string().trim().min(1).max(280),
  healthKey: z.string().trim().min(1).max(64),
});

export const markDoneSchema = z.discriminatedUnion('target', [
  markMilestoneDoneSchema,
  markHealthDoneSchema,
]);

export type MarkDoneInput = z.infer<typeof markDoneSchema>;

export type MarkDoneResult =
  | { status: 'done' }
  | { status: 'preview' }
  | { status: 'invalid'; error: string }
  | { status: 'forbidden' };

export type EditResult =
  | { status: 'edited' }
  | { status: 'preview' }
  | { status: 'invalid'; error: string }
  | { status: 'forbidden' };

export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'preview' }
  | { status: 'invalid'; error: string }
  | { status: 'forbidden' };

export type LogResult =
  | { status: 'logged' }
  | { status: 'preview'; reason: 'no_database' | 'no_auth' }
  | { status: 'invalid'; error: string }
  | { status: 'forbidden' };
