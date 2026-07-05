import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';
import {
  editChildAction,
  setLocationAction,
  setParentNameAction,
} from '~/lib/family/children-actions';
import type {
  MobileFamilyResponse,
  MobileFamilyUpdateRequest,
  MobileFamilyUpdateResponse,
} from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/family — the native Family tab: the household's parents (primary
 * + co-parent) and its editable basics (children, coarse location, plan tier),
 * mirroring the web family page. Both loaders own the DB; this route never touches
 * it (rule #1). Auth() is the 401 gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const [members, basics] = await Promise.all([loadFamilyMembers(), loadFamilyBasics()]);

  const body: MobileFamilyResponse = { members, basics };
  return NextResponse.json(body);
}

/**
 * POST /api/mobile/family — the native Family tab's edits: edit a child (name +
 * DOB), set the household's coarse location, or edit the parent's display name.
 * Each `action` delegates to the EXACT server action the web Family/Settings pages
 * call (editChildAction / setLocationAction / setParentNameAction), so the shared
 * lib owns validation, the family-scoping that keeps a caller inside their own
 * household (rule #1), and the audit_log write (rule #6). This route never touches
 * the DB itself — it only dispatches. Auth() is the 401 gate; the action's own
 * `preview` / `unauthenticated` / `not_found` / `invalid` outcomes map to statuses.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as MobileFamilyUpdateRequest | null;
  if (!body || typeof body.action !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await dispatch(body);

  switch (result.status) {
    case 'updated':
      return NextResponse.json({ status: 'updated' } satisfies MobileFamilyUpdateResponse);
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    case 'not_found':
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    default:
      return NextResponse.json({ error: result.error }, { status: 400 });
  }
}

type DispatchResult =
  | { status: 'updated' }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'not_found' }
  | { status: 'invalid'; error: string };

async function dispatch(body: MobileFamilyUpdateRequest): Promise<DispatchResult> {
  switch (body.action) {
    case 'editChild': {
      const result = await editChildAction(body.childId, {
        name: body.name,
        dateOfBirth: body.dateOfBirth,
      });
      if (result.status === 'invalid') {
        return { status: 'invalid', error: result.error };
      }
      return result;
    }
    case 'setLocation': {
      return setLocationAction({
        country: body.country,
        province: body.province,
        city: body.city,
        postalCode: body.postalCode,
      });
    }
    case 'setParentName': {
      const result = await setParentNameAction(body.name);
      if (result.status === 'invalid') {
        return { status: 'invalid', error: 'name_required' };
      }
      return result;
    }
    default:
      return { status: 'invalid', error: 'unknown_action' };
  }
}
