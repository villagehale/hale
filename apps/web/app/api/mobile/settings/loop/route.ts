import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import type { LoopPrefUpdate } from '~/lib/loop/prefs';
import { loadLoopNotificationPrefs, setLoopPref } from '~/lib/settings/loop-prefs';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/settings/loop — the native Settings screen's F11 loop
 * preferences (channel, quiet hours, weekly send time, categories, name level).
 * The lib owns the DB read (rule #1); this route never touches it. Auth() is the
 * 401 gate (the Edge middleware bridges the Bearer token to the session).
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const result = await loadLoopNotificationPrefs();
  switch (result.status) {
    case 'ready':
      return NextResponse.json({ loop: result.prefs });
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}

/**
 * PATCH /api/mobile/settings/loop — set one loop preference field. Delegates to
 * the shared lib, which VALIDATES the untrusted (field, value) against the
 * writable-field allowlist + per-field value shape, resolves the caller's family
 * (rule #1), and writes an immutable audit_log row (rule #6). Auth() is the 401
 * gate; a malformed field/value returns 400.
 */
export async function PATCH(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { field?: unknown; value?: unknown } | null;
  if (!body || typeof body.field !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await setLoopPref({ field: body.field, value: body.value } as LoopPrefUpdate);
  switch (result.status) {
    case 'updated':
      return NextResponse.json({ status: 'updated' });
    case 'invalid':
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
