import { NextResponse } from 'next/server';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { alreadyPaidParentHasThread } from '~/lib/billing/checkout-payer';
import { verifyPromoJoinCode } from '~/lib/billing/new-visitor-join';
import { newVisitorFoundingAllowedFromRequest } from '~/lib/billing/promo-access';
import {
  PROMO_JOIN_COOKIE,
  PROMO_JOIN_TTL_SECONDS,
  signPromoJoinBinding,
} from '~/lib/billing/promo-join-cookie';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

/**
 * POST /api/promo/join/verify { phone, code } — spend the OTP, attach a pending
 * family, set the short-lived join cookie. Collapses every refusal to 401.
 */
export async function POST(req: Request): Promise<Response> {
  if (!newVisitorFoundingAllowedFromRequest(req)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as {
    phone?: string;
    code?: string;
  } | null;
  const phone = typeof body?.phone === 'string' ? body.phone : '';
  const code = typeof body?.code === 'string' ? body.code : '';
  if (!phone || !code) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await verifyPromoJoinCode(db(), { phoneRaw: phone, code });
  if (result.status !== 'ok') {
    console.info({ reason: result.reason }, 'promo-join: verify refused');
    return NextResponse.json({ error: 'refused' }, { status: 401 });
  }

  const token = signPromoJoinBinding({
    familyId: result.familyId,
    userId: result.userId,
    externalAuthId: result.externalAuthId,
  });
  if (!token) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const hasThread = result.alreadyPaid
    ? await alreadyPaidParentHasThread(db(), result.familyId, result.userId)
    : false;
  const res = NextResponse.json({
    status: 'ok',
    alreadyPaid: result.alreadyPaid,
    ...(hasThread === false ? {} : { hasThread }),
  });
  res.cookies.set(PROMO_JOIN_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PROMO_JOIN_TTL_SECONDS,
  });
  return res;
}
