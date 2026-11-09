import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { SavedPushWatch, StoredPushWatch } from './google-push-watch';

/**
 * Persistence for push subscriptions. Debounce is a conditional UPDATE so two
 * notifications arriving together cannot both win the right to sync.
 */

/**
 * How long a claimed sync holds the window. Pushes inside it while the sync is in
 * flight collapse into one trailing sync. A run that finishes releases the window at
 * once (releaseIdlePushDebounce); this bound only frees one that died mid-sync.
 */
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

/**
 * Save a watch, only for an integration that still holds keys, checked under a lock on
 * the integrations row. A disconnect takes the same lock to end the row, so a renewal
 * that listed the row as live before the disconnect committed cannot put a watch back
 * after the disconnect's settle deleted it (VIL-156). `integration_ended`: nothing saved.
 */
export async function savePushWatch(
  database: Database,
  integrationId: string,
  watch: SavedPushWatch,
): Promise<'saved' | 'integration_ended'> {
  const now = new Date();
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const live = await tx
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.id, integrationId),
          isNotNull(schema.integrations.oauthTokensEncrypted),
        ),
      )
      .for('update');
    if (live.length === 0) return 'integration_ended' as const;
    await tx
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
    return 'saved' as const;
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

/**
 * A finished run gives the window back, unless a push landed after its last check and
 * is still owed a sync (false). One statement, so a push cannot land between the check
 * and the release and be left waiting for the poll.
 */
export async function releaseIdlePushDebounce(
  database: Database,
  integrationId: string,
  now: Date,
): Promise<boolean> {
  const released = await database
    .update(schema.googlePushSubscriptions)
    .set({ debounceUntil: now, updatedAt: now })
    .where(
      and(
        eq(schema.googlePushSubscriptions.integrationId, integrationId),
        eq(schema.googlePushSubscriptions.pending, false),
      ),
    )
    .returning({ integrationId: schema.googlePushSubscriptions.integrationId });
  return released.length > 0;
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
