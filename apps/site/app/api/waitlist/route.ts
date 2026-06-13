import { NextResponse } from 'next/server';
import {
  createRedisRateLimiter,
  createWaitlistStore,
  extractClientIp,
} from '~/lib/waitlist-store';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const raw = body && typeof body.email === 'string' ? body.email : '';
  const email = raw.trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'enter a valid email address' }, { status: 400 });
  }

  try {
    const ip = extractClientIp(request.headers);
    const { allowed } = await createRedisRateLimiter().check(ip);
    if (!allowed) {
      return NextResponse.json(
        { error: 'too many requests — please try again later' },
        { status: 429 },
      );
    }

    // Membership is never revealed: a new and an existing email get the same
    // body. We intentionally drop `created` from the response.
    await createWaitlistStore().add(email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('waitlist store failed', err);
    return NextResponse.json(
      { error: 'could not save your spot right now — please try again' },
      { status: 503 },
    );
  }
}
