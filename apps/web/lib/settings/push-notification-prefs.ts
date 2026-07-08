import { type Database, schema } from '@hale/db';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { type PushPrefsView, loadPushPrefsView } from '~/lib/push/prefs';

/**
 * The PUSH notification preferences behind the mobile Settings screen: the two
 * streams a parent controls in the native app — new village picks and health
 * reminders. Distinct from the daily-brief EMAIL (a CASL opt-out on email_opt_outs,
 * owned by lib/settings/notification-prefs): push is a transactional, in-app
 * signal, so both streams default ON and a parent turns one off here — the toggle
 * upserts a notification_prefs row (its absence IS "both on").
 *
 * This is the single source of truth the mobile notifications route calls: read
 * the current state, and toggle it. A toggle resolves the caller's family (never a
 * fabricated id — rule #1) and writes an immutable audit_log row (rule #6). The
 * audit carries only the pref name + values — never child content.
 *
 * Degradation mirrors the email prefs lib: no DATABASE_URL / auth-unconfigured
 * returns `preview`, a configured-but-signed-out caller returns `unauthenticated`,
 * and a signed-in parent whose family hasn't resolved yet returns `not_found`.
 */

/** The two push streams a parent controls in Settings. */
export type PushPref = 'pushNewPicks' | 'pushHealthReminders';

export type LoadPushPrefsResult =
  | { status: 'ready'; prefs: PushPrefsView }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' };

export async function loadPushNotificationPrefs(): Promise<LoadPushPrefsResult> {
  const ctx = await prefContext();
  if (ctx.status !== 'ready') {
    return { status: ctx.status };
  }
  const prefs = await loadPushPrefsView(ctx.userId, ctx.database);
  return { status: 'ready', prefs };
}

export type SetPushPrefResult =
  | { status: 'updated' }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' };

export async function setPushNotificationPref(
  pref: PushPref,
  enabled: boolean,
): Promise<SetPushPrefResult> {
  const ctx = await prefContext();
  if (ctx.status !== 'ready') {
    return { status: ctx.status };
  }

  const { database, userId, familyId } = ctx;
  await database.transaction(async (tx) => {
    await tx
      .insert(schema.notificationPrefs)
      .values({ userId, [pref]: enabled })
      .onConflictDoUpdate({
        target: schema.notificationPrefs.userId,
        set: { [pref]: enabled, updatedAt: new Date() },
      });

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'notification_pref_updated',
      targetTable: 'notification_prefs',
      targetId: userId,
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
 * read/write. The two auth boundaries stay DISTINCT (as in the email prefs lib):
 * `preview` = auth genuinely unconfigured here; `unauthenticated` = configured but
 * no session; `not_found` = a real signed-in parent whose family hasn't been
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
