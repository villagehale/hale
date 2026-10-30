import { NextResponse } from 'next/server';
import { stampCronHeartbeat } from '~/lib/cron/heartbeat';
import { db } from '~/lib/db';

/**
 * Cron-call authentication.
 *
 * Vercel Cron invokes a route with `Authorization: Bearer <CRON_SECRET>` (the
 * value of the CRON_SECRET project env var). This is the ONLY thing that may
 * trigger a scheduled agent run — a passive engine that spends real Anthropic
 * tokens must never run for an arbitrary internet caller. So every cron route
 * calls this BEFORE any work: a missing/empty CRON_SECRET, or a request whose
 * bearer token does not match, gets a 401 and the handler does NOTHING (no DB
 * read, no model call, no spend).
 *
 * Fail closed: if CRON_SECRET is unset the route is unreachable (401), rather
 * than open to everyone. The comparison is a plain string equality on a
 * server-only secret; there is no user-controlled timing oracle here that a
 * constant-time compare would meaningfully defend (the secret is high-entropy
 * and never echoed).
 */
export function requireCronSecret(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'cron_not_configured' }, { status: 401 });
  }
  const header = req.headers.get('authorization');
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

/**
 * The one door every cron route walks through: the secret gate above, the
 * handler, then a `cron_heartbeats` stamp — the dead-man switch's evidence of
 * life (audit P1-8; read by /api/health/crons, checked from off-Vercel by
 * .github/workflows/cron-deadman.yml). Routes export
 * `GET = cronRoute('<slug>', handler)` instead of calling requireCronSecret
 * themselves, so a new cron CANNOT get auth without the stamp
 * (heartbeat-guard.test.ts enforces it).
 *
 * `name` is the route's path slug ('/api/cron/drain' → 'drain') — the same key
 * the health endpoint derives from vercel.json.
 *
 * Stamping rules, all deliberate:
 * - On COMPLETION, not invocation: a handler that returns — even a 4xx/5xx
 *   verdict of its own — proves the substrate invoked the route and the route
 *   finished. Job-level failure is a different alarm (triage, digests).
 * - A THROWING handler does not stamp, so a cron that crashes every run reads
 *   stale and pages. The throw still propagates untouched.
 * - A failed stamp never fails the cron: the outcome is named in the log line
 *   below, and its absence is exactly what the dead-man endpoint makes visible
 *   from outside (rule #11 — the missing write IS the alarm signal, never a
 *   silent no-op).
 */
export function cronRoute(
  name: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const denied = requireCronSecret(req);
    if (denied) return denied;
    const response = await handler(req);
    try {
      await stampCronHeartbeat(db(), name);
    } catch (err) {
      console.error('cron heartbeat stamp failed — this cron will read stale on /api/health/crons', {
        cron: name,
        err,
      });
    }
    return response;
  };
}
