import { NextResponse } from 'next/server';
import { APP_URL } from '~/lib/app-url';

export const dynamic = 'force-dynamic';

const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

/** The page posts the code here. hale-web binds the number only after it matches. */
export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request);
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!SESSION_ID.test(sessionId))
    return NextResponse.json({ status: 'no_payment' }, { status: 400 });
  const code = typeof body?.code === 'string' ? body.code.slice(0, 12) : '';
  if (!code) return NextResponse.json({ status: 'wrong_code' }, { status: 400 });
  try {
    const res = await fetch(`${APP_URL.replace(/\/$/, '')}/api/billing/pricing-checkout/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, code }),
      cache: 'no-store',
    });
    const payload = (await res.json().catch(() => null)) as {
      status?: unknown;
      attemptsRemaining?: unknown;
    } | null;
    const status = typeof payload?.status === 'string' ? payload.status : 'no_pending';
    const attemptsRemaining =
      typeof payload?.attemptsRemaining === 'number' ? payload.attemptsRemaining : undefined;
    return NextResponse.json(
      { status, ...(attemptsRemaining !== undefined ? { attemptsRemaining } : {}) },
      { status: res.ok ? 200 : 502 },
    );
  } catch {
    return NextResponse.json({ status: 'no_pending' }, { status: 502 });
  }
}

async function readBody(request: Request): Promise<{ sessionId?: unknown; code?: unknown } | null> {
  const text = await request.text();
  if (text.length > 2000) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { sessionId?: unknown; code?: unknown })
      : null;
  } catch {
    return null;
  }
}
