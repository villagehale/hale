import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import { addArea, hasCoordinateFields, listAreas, removeArea, setActiveArea } from '~/lib/village/areas';
import type {
  MobileVillageAreaUpdateRequest,
  MobileVillageAreasResponse,
} from '../../types';

export const runtime = 'nodejs';

/**
 * GET/POST /api/mobile/village/areas — the region switcher behind the Village
 * header. GET lists the family's saved COARSE areas + which one is active; POST
 * adds a coarse {city, province, note?} OR activates one by id. Every write is
 * family-scoped to the caller (rule #1) and audited server-side (rule #6) inside
 * the areas lib. Auth() is the 401 gate; an authed user with no resolved family
 * (onboarding incomplete) → 403.
 *
 * PRIVACY (rule #1): the server never accepts or stores precise coordinates. A
 * payload carrying any latitude/longitude-shaped key is refused (400
 * coordinates_forbidden). "Use my current location" is NOT a separate server path:
 * the CLIENT resolves the device location to a coarse {city, province} ON-DEVICE
 * and calls this SAME add/setActive endpoint — the server treats it identically to
 * a typed city and only ever sees the coarse area.
 */
export async function GET(): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  return NextResponse.json(await areasResponse(database, familyId));
}

export async function POST(req: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw.action !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  // Refuse any payload that carried precise coordinates before touching the DB
  // (rule #1) — the switcher deals only in coarse {city, province}.
  if (hasCoordinateFields(raw)) {
    return NextResponse.json({ error: 'coordinates_forbidden' }, { status: 400 });
  }

  const database = db();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  const userId = await resolveUserIdForUser(session.user.id, database);
  if (!userId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const body = raw as unknown as MobileVillageAreaUpdateRequest;

  if (body.action === 'add') {
    const result = await addArea(database, {
      familyId,
      userId,
      input: {
        city: body.city,
        province: body.province,
        note: body.note,
        postalCode: body.postalCode,
      },
    });
    switch (result.status) {
      case 'added':
      case 'duplicate':
        return NextResponse.json(await areasResponse(database, familyId));
      case 'cap_reached':
        return NextResponse.json({ error: 'cap_reached' }, { status: 409 });
      default:
        return NextResponse.json({ error: result.error }, { status: 400 });
    }
  }

  if (body.action === 'setActive') {
    const result = await setActiveArea(database, { familyId, userId, areaId: body.areaId });
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'area_not_found' }, { status: 404 });
    }
    return NextResponse.json(await areasResponse(database, familyId));
  }

  if (body.action === 'remove') {
    const result = await removeArea(database, { familyId, userId, areaId: body.areaId });
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'area_not_found' }, { status: 404 });
    }
    // The active area can't be removed — the client switches away first (rule: an empty
    // active area would leave the feed with nowhere to scope to).
    if (result.status === 'active') {
      return NextResponse.json({ error: 'active_area' }, { status: 409 });
    }
    return NextResponse.json(await areasResponse(database, familyId));
  }

  return NextResponse.json({ error: 'unknown_action' }, { status: 400 });
}

/** The family's saved areas + the active one's id — the shape both GET and a
 * successful POST return so the client always re-renders on fresh state. */
async function areasResponse(
  database: ReturnType<typeof db>,
  familyId: string,
): Promise<MobileVillageAreasResponse> {
  const areas = await listAreas(database, familyId);
  return { areas, activeAreaId: areas.find((area) => area.isActive)?.id ?? null };
}
