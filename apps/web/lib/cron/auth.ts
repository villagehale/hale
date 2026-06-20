import { NextResponse } from 'next/server';

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
