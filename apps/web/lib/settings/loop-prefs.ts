import type { Database } from '@hale/db';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import {
  type LoopPrefUpdate,
  type LoopPrefsView,
  isValidLoopPrefUpdate,
  loadLoopPrefsView,
  writeLoopPref,
} from '~/lib/loop/prefs';

/**
 * The Settings-facing loader/mutator for F11 loop preferences (VIL-216 · A5) —
 * the single source of truth the web Settings card and the mobile route call.
 * Mirrors push-notification-prefs.ts: read the current view, or update one field
 * with the audited upsert (rule #6). The validation + write + absent-row default
 * live in lib/loop/prefs (auth-free, unit-tested); this file only adds the
 * auth/family resolution and the degradation contract.
 *
 * Degradation mirrors the push/email prefs libs: no DATABASE_URL / auth-
 * unconfigured → `preview`; configured-but-signed-out → `unauthenticated`; a
 * signed-in parent whose family hasn't resolved → `not_found`. Never fabricates an
 * identity (rule #1).
 */

export type { LoopPrefUpdate };

export type LoadLoopPrefsResult =
  | { status: 'ready'; prefs: LoopPrefsView }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' };

export type SetLoopPrefResult =
  | { status: 'updated' }
  | { status: 'invalid' }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' };

export async function loadLoopNotificationPrefs(): Promise<LoadLoopPrefsResult> {
  const ctx = await loopPrefContext();
  if (ctx.status !== 'ready') {
    return { status: ctx.status };
  }
  const prefs = await loadLoopPrefsView(ctx.userId, ctx.database);
  return { status: 'ready', prefs };
}

export async function setLoopPref(update: LoopPrefUpdate): Promise<SetLoopPrefResult> {
  if (!isValidLoopPrefUpdate(update)) {
    return { status: 'invalid' };
  }
  const ctx = await loopPrefContext();
  if (ctx.status !== 'ready') {
    return { status: ctx.status };
  }
  await writeLoopPref(ctx.database, ctx.userId, ctx.familyId, update);
  return { status: 'updated' };
}

type LoopPrefContext =
  | { status: 'ready'; database: Database; userId: string; familyId: string }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' };

/**
 * Resolves the signed-in parent's user id + family + db handle. Kept as its own
 * copy (as the push and email prefs libs each do) so the loop feature owns its
 * degradation contract; the three distinct auth boundaries never fabricate an
 * identity (rule #1).
 */
async function loopPrefContext(): Promise<LoopPrefContext> {
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
