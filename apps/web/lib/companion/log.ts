'use server';

import { revalidatePath } from 'next/cache';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import {
  BOOKING_EPISODE,
  type BookingResult,
  type LogResult,
  bookingSchema,
  quickLogSchema,
} from './log-types.js';
import { buildEpisodeInsert, childBelongsToFamily, writeEpisode } from './log-write.js';

/**
 * Quick-log server actions. A parent logging a feed, nap, or milestone — or
 * asking Hale to help book a health item — is a direct user action, so each
 * writes a family_memory_episodes row plus an immutable audit_log row in one
 * transaction (rule #6, in log-write).
 *
 * Rule #1: episodes are family-level care logs with no precise location; nothing
 * leaves the family, and a parent only ever logs against their own children
 * (childBelongsToFamily fails closed otherwise).
 *
 * Degrades to a preview (never a write, never a crash) when there is no
 * DATABASE_URL or no resolved family — mirroring the onboarding persist path.
 */

export async function logQuickEpisode(raw: unknown, now: Date = new Date()): Promise<LogResult> {
  const parsed = quickLogSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  if (!process.env.DATABASE_URL) {
    return { status: 'preview', reason: 'no_database' };
  }
  if (!authConfigured()) {
    return { status: 'preview', reason: 'no_auth' };
  }

  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return { status: 'preview', reason: 'no_auth' };
  }

  if (!(await childBelongsToFamily(database, familyId, parsed.data.childId))) {
    return { status: 'forbidden' };
  }

  await writeEpisode(database, buildEpisodeInsert(parsed.data, familyId, now));

  revalidatePath('/companion');
  revalidatePath('/home');
  return { status: 'logged' };
}

/**
 * Behind the "we'll help you book" button on a health item. Hale cannot actually
 * book an external appointment, so this records the parent's INTENT as a
 * booking_requested episode (never a fake success) plus its audit row — the
 * worker pipeline can later turn it into a real drafted action. When a childId is
 * given it must belong to the family; family-wide intents carry a null childId.
 */
export async function logBookingRequested(
  raw: unknown,
  now: Date = new Date(),
): Promise<BookingResult> {
  const parsed = bookingSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  if (!process.env.DATABASE_URL || !authConfigured()) {
    return { status: 'preview' };
  }

  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return { status: 'preview' };
  }

  if (
    parsed.data.childId &&
    !(await childBelongsToFamily(database, familyId, parsed.data.childId))
  ) {
    return { status: 'forbidden' };
  }

  await writeEpisode(database, {
    familyId,
    childId: parsed.data.childId ?? null,
    occurredAt: now,
    episodeType: BOOKING_EPISODE,
    summary: `Asked Hale to help book: ${parsed.data.what}`,
    payload: { what: parsed.data.what },
  });

  revalidatePath('/companion');
  revalidatePath('/home');
  return { status: 'requested' };
}
