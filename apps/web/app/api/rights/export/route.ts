import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { capturePortalEventAfter } from '~/lib/analytics/server-capture';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { listSeatsForUser, resolveUserIdForUser } from '~/lib/family';
import { assembleFamilyExport } from '~/lib/rights/export';
import { exportSeat } from '~/lib/rights/export-seat';

// Node runtime: the assembler uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

/**
 * GET /api/rights/export — a parent downloads everything Hale holds about their
 * family (PIPEDA/Law 25 right-to-access + portability). Auth mirrors the share
 * route (rule #1): dev-preview → 501; signed out → 401; no family / no user → 403.
 * The assembler writes the immutable audit_log row (rule #6) and applies the same
 * teen redaction the app already shows — the requesting parent gets exactly what
 * they can already see, never raw teen content.
 *
 * Only a PARENT seat takes the family's record (`exportSeat`). The seats are enumerated
 * rather than resolved through `resolveFamilyForUser`, whose `limit(1)` has no ORDER BY:
 * a nanny of one household who parents another must get their own, never whichever row
 * came back first. No parent seat → 403 `export_parent_only`; two → 409
 * `export_family_ambiguous`. Each refusal is logged by outcome and roles only.
 */
export async function GET(_req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to export your data' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const actorUserId = await resolveUserIdForUser(externalAuthId, database);
  const seats = actorUserId ? await listSeatsForUser(actorUserId, database) : [];
  if (!actorUserId || seats.length === 0) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const seat = exportSeat(seats);
  if (seat.outcome !== 'export') {
    console.info(
      { outcome: seat.outcome, roles: seats.map((s) => s.role) },
      'rights/export: refused',
    );
    return NextResponse.json(
      { error: seat.outcome },
      { status: seat.outcome === 'export_parent_only' ? 403 : 409 },
    );
  }
  const { familyId } = seat;

  const document = await assembleFamilyExport(database, familyId, { actorUserId });
  capturePortalEventAfter('portal_export_requested', familyId, 'rights_api');

  const filename = `hale-export-${document.exportedAt.slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}
