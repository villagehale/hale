import { NextResponse } from 'next/server';
import { APP_URL } from '~/lib/app-url';

export const dynamic = 'force-dynamic';

const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

/** The page posts here. hale-web sends the Linq code. The browser stays on this site. */
export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request);
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!SESSION_ID.test(sessionId)) {
    return NextResponse.json({ direct: false, status: 'no_payment' }, { status: 400 });
  }
  const phone = typeof body?.phone === 'string' ? body.phone.slice(0, 24) : undefined;
  return proxy(`${APP_URL.replace(/\/$/, '')}/api/billing/pricing-checkout/code`, {
    sessionId,
    phone,
    resend: body?.resend === true,
  });
}

async function proxy(url: string, body: unknown): Promise<Response> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const payload = await res.json().catch(() => null);
    return NextResponse.json(payload ?? { status: 'send_failed' }, { status: res.ok ? 200 : 502 });
  } catch {
    return NextResponse.json({ status: 'send_failed' }, { status: 502 });
  }
}

async function readBody(
  request: Request,
): Promise<{ sessionId?: unknown; phone?: unknown; resend?: unknown } | null> {
  const text = await request.text();
  if (text.length > 2000) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { sessionId?: unknown; phone?: unknown; resend?: unknown })
      : null;
  } catch {
    return null;
  }
}
