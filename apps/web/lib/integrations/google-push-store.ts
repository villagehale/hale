import { type Database, schema } from '@hale/db';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { SavedPushWatch, StoredPushWatch } from './google-push-watch';

/**
 * Persistence for push subscriptions. Debounce is a conditional UPDATE so two
 * notifications arriving together cannot both win the right to sync.
 */

/** Collapses a burst of pushes for one connection into one sync, plus one trailing. */
export const GOOGLE_PUSH_DEBOUNCE_MS = 15_000;

const SWEEPABLE = ['active', 'error'] as const;

export interface CalendarChannelRecord {
  integrationId: string;
  channelId: string;
  resourceId: string;
  tokenHash: string;
}

export async function loadCalendarChannel(
  database: Database,
  channelId: string,
): Promise<CalendarChannelRecord | null> {
  const rows = await database
    .select({
      integrationId: schema.googlePushSubscriptions.integrationId,
      channelId: schema.googlePushSubscriptions.channelId,
      resourceId: schema.googlePushSubscriptions.resourceId,
      tokenHash: schema.googlePushSubscriptions.tokenHash,
    })
    .from(schema.googlePushSubscriptions)
    .innerJoin(
      schema.integrations,
      eq(schema.integrations.id, schema.googlePushSubscriptions.integrationId),
    )
    .where(
      and(
        eq(schema.googlePushSubscriptions.channelId, channelId),
        inArray(schema.integrations.status, [...SWEEPABLE]),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row?.channelId || !row.resourceId || !row.tokenHash) return null;
  return {
    integrationId: row.integrationId,
    channelId: row.channelId,
    resourceId: row.resourceId,
    tokenHash: row.tokenHash,
  };
}

/** Every sweepable Gmail connection publishing from this mailbox. */
export async function loadGmailIntegrations(
  database: Database,
  mailboxKey: string,
): Promise<string[]> {
  const rows = await database
    .select({ integrationId: schema.googlePushSubscriptions.integrationId })
    .from(schema.googlePushSubscriptions)
    .innerJoin(
      schema.integrations,
      eq(schema.integrations.id, schema.googlePushSubscriptions.integrationId),
    )
    .where(
      and(
        eq(schema.googlePushSubscriptions.provider, 'gmail'),
        eq(schema.googlePushSubscriptions.mailboxKey, mailboxKey),
        inArray(schema.integrations.status, [...SWEEPABLE]),
      ),
    );
  return rows.map((row) => row.integrationId);
}

export async function loadPushWatch(
  database: Database,
  integrationId: string,
): Promise<StoredPushWatch | null> {
  const rows = await database
    .select({
      provider: schema.googlePushSubscriptions.provider,
      expiration: schema.googlePushSubscriptions.expiration,
      channelId: schema.googlePushSubscriptions.channelId,
      resourceId: schema.googlePushSubscriptions.resourceId,
    })
    .from(schema.googlePushSubscriptions)
    .where(eq(schema.googlePushSubscriptions.integrationId, integrationId))
    .limit(1);
  const row = rows[0];
  if (!row || (row.provider !== 'gcal' && row.provider !== 'gmail')) return null;
  return {
    provider: row.provider,
    expiration: row.expiration,
    channelId: row.channelId,
    resourceId: row.resourceId,
  };
}

export async function savePushWatch(
  database: Database,
  integrationId: string,
  watch: SavedPushWatch,
): Promise<void> {
  const now = new Date();
  await database
    .insert(schema.googlePushSubscriptions)
    .values({
      integrationId,
      provider: watch.provider,
      channelId: watch.channelId,
      resourceId: watch.resourceId,
      tokenHash: watch.tokenHash,
      mailboxKey: watch.mailboxKey,
      topicName: watch.topicName,
      expiration: watch.expiration,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.googlePushSubscriptions.integrationId,
      set: {
        provider: watch.provider,
        channelId: watch.channelId,
        resourceId: watch.resourceId,
        tokenHash: watch.tokenHash,
        mailboxKey: watch.mailboxKey,
        topicName: watch.topicName,
        expiration: watch.expiration,
        updatedAt: now,
      },
    });
}

export async function deletePushWatch(database: Database, integrationId: string): Promise<void> {
  await database
    .delete(schema.googlePushSubscriptions)
    .where(eq(schema.googlePushSubscriptions.integrationId, integrationId));
}

/**
 * Claim the right to sync now, or record that a later trailing sync is owed.
 * `coalesce` means another run already owns the window.
 */
export async function claimPushDebounce(
  database: Database,
  integrationId: string,
  now: Date,
): Promise<'run' | 'coalesce'> {
  const until = new Date(now.getTime() + GOOGLE_PUSH_DEBOUNCE_MS);
  const claimed = await database
    .update(schema.googlePushSubscriptions)
    .set({ debounceUntil: until, pending: false, updatedAt: now })
    .where(
      and(
        eq(schema.googlePushSubscriptions.integrationId, integrationId),
        or(
          sql`${schema.googlePushSubscriptions.debounceUntil} IS NULL`,
          lte(schema.googlePushSubscriptions.debounceUntil, now),
        ),
      ),
    )
    .returning({ integrationId: schema.googlePushSubscriptions.integrationId });
  if (claimed.length > 0) return 'run';
  await database
    .update(schema.googlePushSubscriptions)
    .set({ pending: true, updatedAt: now })
    .where(eq(schema.googlePushSubscriptions.integrationId, integrationId));
  return 'coalesce';
}

/** True when a push landed during the in-flight sync and one more run is owed. */
export async function takePushPending(
  database: Database,
  integrationId: string,
  now: Date,
): Promise<boolean> {
  const taken = await database
    .update(schema.googlePushSubscriptions)
    .set({ pending: false, updatedAt: now })
    .where(
      and(
        eq(schema.googlePushSubscriptions.integrationId, integrationId),
        eq(schema.googlePushSubscriptions.pending, true),
      ),
    )
    .returning({ integrationId: schema.googlePushSubscriptions.integrationId });
  return taken.length > 0;
}

/** A failed sync gives the next push the window back, so Google's retry is not dropped. */
export async function releasePushDebounce(
  database: Database,
  integrationId: string,
  now: Date,
): Promise<void> {
  await database
    .update(schema.googlePushSubscriptions)
    .set({ debounceUntil: now, updatedAt: now })
    .where(eq(schema.googlePushSubscriptions.integrationId, integrationId));
}
