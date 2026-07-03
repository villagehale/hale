import { z } from 'zod';

/**
 * Quick-log episode shapes shared by the server action (log.ts) and the client
 * form (quick-log.tsx). Kept out of the 'use server' module because a server
 * module may only export async functions — constants, schemas, and types live
 * here so the client can import them without pulling server code over the wire.
 */

export const FEED_EPISODE = 'feed';
export const NAP_EPISODE = 'nap';
export const MILESTONE_EPISODE = 'milestone';
export const BOOKING_EPISODE = 'booking_requested';

/** A feed's kind, surfaced in the timeline. 'unspecified' is the default when a
 * parent doesn't pick one (kept out of the summary). */
export const FEED_KINDS = ['bottle', 'breast', 'solid'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** How far in the future a logged time may be (small clock-skew tolerance) and
 * how far back it may reach. A quick-log is a recent household event, so a year
 * back is generous while still rejecting an absurd / mistyped date. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_BACKDATE_MS = 365 * 24 * 60 * 60 * 1000;

/** An optional logged time: an ISO/datetime-local string, validated to a real
 * date. Range bounds are checked at the action boundary against the request
 * clock (validateOccurredAt), since "now" is only authoritative there. */
const occurredAtField = z.string().trim().min(1).datetime({ offset: true }).optional();

export const feedSchema = z.object({
  kind: z.literal(FEED_EPISODE),
  childId: z.string().uuid(),
  amountMl: z.coerce.number().positive().max(2000),
  feedKind: z.enum(FEED_KINDS).optional(),
  note: z.string().trim().max(280).optional(),
  occurredAt: occurredAtField,
});

export const napSchema = z.object({
  kind: z.literal(NAP_EPISODE),
  childId: z.string().uuid(),
  durationMin: z.coerce.number().positive().max(1440),
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

export const quickLogSchema = z.discriminatedUnion('kind', [
  feedSchema,
  napSchema,
  milestoneSchema,
]);

export type QuickLogInput = z.infer<typeof quickLogSchema>;

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
