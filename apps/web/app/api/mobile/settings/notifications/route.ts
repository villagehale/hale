import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import {
  loadPushNotificationPrefs,
  setPushNotificationPref,
} from '~/lib/settings/push-notification-prefs';
import type {
  MobilePushPrefsResponse,
  MobilePushPrefsUpdateRequest,
  MobilePushPrefsUpdateResponse,
} from '../../types';

export const runtime = 'nodejs';

const PUSH_PREFS = ['pushNewPicks', 'pushHealthReminders'] as const;

/**
 * GET /api/mobile/settings/notifications — the native Settings screen's two PUSH
 * toggles (new village picks + health reminders). The lib owns the DB read (rule
 * #1); this route never touches it. Auth() is the 401 gate (the Edge middleware
 * bridges the Bearer token to the session, so a signed-in app caller resolves).
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const result = await loadPushNotificationPrefs();
  switch (result.status) {
    case 'ready':
      return NextResponse.json({ notifications: result.prefs } satisfies MobilePushPrefsResponse);
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}

/**
 * PATCH /api/mobile/settings/notifications — toggle one push stream. Delegates to
 * the shared lib, which resolves the caller's family (rule #1) and writes an
 * immutable audit_log row (rule #6). Auth() is the 401 gate; the write is
 * user-scoped inside the lib (the pref row is keyed on the resolved user id).
 */
export async function PATCH(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as MobilePushPrefsUpdateRequest | null;
  if (
    !body ||
    !PUSH_PREFS.includes(body.pref as (typeof PUSH_PREFS)[number]) ||
    typeof body.enabled !== 'boolean'
  ) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await setPushNotificationPref(body.pref, body.enabled);
  switch (result.status) {
    case 'updated':
      return NextResponse.json({ status: 'updated' } satisfies MobilePushPrefsUpdateResponse);
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
