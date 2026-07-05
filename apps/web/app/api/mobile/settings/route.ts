import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import {
  loadNotificationPrefs,
  setNotificationPrefAction,
} from '~/lib/settings/notification-prefs';
import type {
  MobileSettingsResponse,
  MobileSettingsUpdateRequest,
  MobileSettingsUpdateResponse,
} from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/settings — the native Settings screen's actionable state: the
 * notification streams the parent controls (today, the daily brief email). The
 * lib owns the DB read (rule #1); this route never touches it. Auth() is the 401
 * gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const result = await loadNotificationPrefs();
  switch (result.status) {
    case 'ready':
      return NextResponse.json({ notifications: result.prefs } satisfies MobileSettingsResponse);
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}

/**
 * POST /api/mobile/settings — toggle a notification preference. Delegates to the
 * shared lib, which resolves the caller's family (rule #1) and writes an immutable
 * audit_log row (rule #6). Auth() is the 401 gate.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as MobileSettingsUpdateRequest | null;
  if (!body || body.pref !== 'dailyBriefEmail' || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await setNotificationPrefAction(body.pref, body.enabled);
  switch (result.status) {
    case 'updated':
      return NextResponse.json({ status: 'updated' } satisfies MobileSettingsUpdateResponse);
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
