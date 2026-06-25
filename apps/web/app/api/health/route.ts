import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '~/lib/db';

// Node runtime: the DB ping uses the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/health — a cheap uptime probe. Returns 200 with the service status and
 * a DB-reachability check (a `SELECT 1` ping). The ping is fail-soft on purpose:
 * the probe reports `db: 'down'` rather than throwing, so an uptime monitor sees a
 * 200 it can read the status from — and so a credential-less preview (no
 * DATABASE_URL) still answers `db: 'unconfigured'` instead of erroring.
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'hale-web',
    db: await pingDb(),
    timestamp: new Date().toISOString(),
  });
}

async function pingDb(): Promise<'ok' | 'down' | 'unconfigured'> {
  if (!process.env.DATABASE_URL) return 'unconfigured';
  try {
    await db().execute(sql`select 1`);
    return 'ok';
  } catch {
    return 'down';
  }
}
