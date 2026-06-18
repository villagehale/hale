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

export const feedSchema = z.object({
  kind: z.literal(FEED_EPISODE),
  childId: z.string().uuid(),
  amountMl: z.coerce.number().positive().max(2000),
  note: z.string().trim().max(280).optional(),
});

export const napSchema = z.object({
  kind: z.literal(NAP_EPISODE),
  childId: z.string().uuid(),
  durationMin: z.coerce.number().positive().max(1440),
  note: z.string().trim().max(280).optional(),
});

export const milestoneSchema = z.object({
  kind: z.literal(MILESTONE_EPISODE),
  childId: z.string().uuid(),
  milestone: z.string().trim().min(1).max(280),
});

export const quickLogSchema = z.discriminatedUnion('kind', [
  feedSchema,
  napSchema,
  milestoneSchema,
]);

export type QuickLogInput = z.infer<typeof quickLogSchema>;

export const bookingSchema = z.object({
  childId: z.string().uuid().optional(),
  what: z.string().trim().min(1).max(280),
});

export type LogResult =
  | { status: 'logged' }
  | { status: 'preview'; reason: 'no_database' | 'no_auth' }
  | { status: 'invalid'; error: string }
  | { status: 'forbidden' };

export type BookingResult =
  | { status: 'requested' }
  | { status: 'preview' }
  | { status: 'invalid'; error: string }
  | { status: 'forbidden' };
