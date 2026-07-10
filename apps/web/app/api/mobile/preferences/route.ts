import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { setPreferencesAction } from '~/lib/family/children-actions';
import { readUserPreferences } from '~/lib/settings/user-preferences';
import type { UnitSystem } from '@hale/types';
import type { MobilePreferencesResponse, MobilePreferencesUpdateRequest } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/preferences — the native Settings screen's display preferences:
 * `units` (metric/imperial) and `weekStartDay` (0=Sun, 1=Mon). The lib owns the DB
 * read (rule #1); this route never touches it. Auth() is the 401 gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const prefs = await readUserPreferences(session.user.id);
  return NextResponse.json(prefs satisfies MobilePreferencesResponse);
}

const UNIT_SYSTEMS: ReadonlySet<string> = new Set<UnitSystem>(['metric', 'imperial']);
const WEEK_START_DAYS: ReadonlySet<number> = new Set([0, 1]);

/**
 * POST /api/mobile/preferences — set the parent's display preferences. Delegates to
 * the shared server action, which resolves the caller's family (rule #1) and writes
 * an immutable audit_log row (rule #6) via the same path the web card uses. Auth() is
 * the 401 gate; the boundary validates units + weekStartDay before dispatch.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as MobilePreferencesUpdateRequest | null;
  if (
    !body ||
    !UNIT_SYSTEMS.has(body.units) ||
    typeof body.weekStartDay !== 'number' ||
    !WEEK_START_DAYS.has(body.weekStartDay)
  ) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await setPreferencesAction(body.units, body.weekStartDay);
  switch (result.status) {
    case 'updated':
      return NextResponse.json({ status: 'updated' });
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    case 'invalid':
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
