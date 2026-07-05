import { type Database, schema } from '@hale/db';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { hasOptedOut, recordOptIn, recordOptOut } from '~/lib/cron/email-compliance';
import { db as defaultDb } from '~/lib/db';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';

/**
 * The notification preferences behind the Settings page. Today the one stream a
 * parent controls is the daily brief email — a non-transactional (CASL) stream
 * whose consent IS the absence of an opt-out row (email_opt_outs). This lib is the
 * single source of truth the mobile Settings route calls: read the current state,
 * and toggle it. Setting a preference resolves the caller's family (never a
 * fabricated id — rule #1) and writes an immutable audit_log row (rule #6), the
 * same shape the family mutations use.
 *
 * Degradation mirrors the family mutations: no DATABASE_URL / auth-unconfigured
 * returns `preview` (nothing written), a configured-but-signed-out caller returns
 * `unauthenticated`, and a signed-in parent whose family hasn't resolved yet
 * returns `not_found` — never a crash, never a fabricated identity.
 */

/** The notification streams a parent controls in Settings. Today: the daily brief. */
export type NotificationPref = 'dailyBriefEmail';

export interface NotificationPrefsView {
  /** True when the parent receives the daily brief email (no opt-out on file). */
  dailyBriefEmail: boolean;
}

export type LoadNotificationPrefsResult =
  | { status: 'ready'; prefs: NotificationPrefsView }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' };

export async function loadNotificationPrefs(): Promise<LoadNotificationPrefsResult> {
  const ctx = await prefContext();
  if (ctx.status !== 'ready') {
    return { status: ctx.status };
  }

  const { database, userId } = ctx;
  const optedOut = await hasOptedOut(database, userId, 'daily_digest');
  return { status: 'ready', prefs: { dailyBriefEmail: !optedOut } };
}

export type SetNotificationPrefResult =
  | { status: 'updated' }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' };

export async function setNotificationPrefAction(
  pref: NotificationPref,
  enabled: boolean,
): Promise<SetNotificationPrefResult> {
  const ctx = await prefContext();
  if (ctx.status !== 'ready') {
    return { status: ctx.status };
  }

  const { database, userId, familyId } = ctx;
  const before = !(await hasOptedOut(database, userId, 'daily_digest'));
  if (before === enabled) {
    return { status: 'updated' };
  }

  await database.transaction(async (tx) => {
    if (enabled) {
      await recordOptIn(tx as unknown as Database, userId, 'daily_digest');
    } else {
      await recordOptOut(tx as unknown as Database, userId, 'daily_digest');
    }

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'notification_pref_updated',
      targetTable: 'email_opt_outs',
      targetId: userId,
      before: { [pref]: before },
      after: { [pref]: enabled },
    });
  });

  return { status: 'updated' };
}

type PrefContext =
  | { status: 'ready'; database: Database; userId: string; familyId: string }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' };

/**
 * Resolves the signed-in parent's user id + family + a db handle for a preference
 * read/write. The two auth boundaries stay DISTINCT (as in the family mutations):
 * `preview` = auth genuinely unconfigured here; `unauthenticated` = configured but
 * no session. `not_found` = a real signed-in parent whose family hasn't been
 * provisioned yet. Never fabricates an identity (rule #1).
 */
async function prefContext(): Promise<PrefContext> {
  if (!process.env.DATABASE_URL || !authConfigured()) {
    return { status: 'preview' };
  }
  const session = await auth();
  const externalAuthId = session?.user?.id;
  const email = session?.user?.email;
  if (!externalAuthId || !email) {
    return { status: 'unauthenticated' };
  }

  const database = defaultDb();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(
    { externalAuthId, email, name: session.user?.name ?? null },
    database,
  );
  return { status: 'ready', database, userId, familyId };
}
