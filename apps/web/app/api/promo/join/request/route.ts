import { NextResponse } from 'next/server';
import { createClaimCodeSender } from '~/lib/auth/claim-code-sender';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { requestPromoJoinCode } from '~/lib/billing/new-visitor-join';
import { newVisitorFoundingAllowedFromRequest } from '~/lib/billing/promo-access';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { db } from '~/lib/db';
import { enforceRateLimit } from '~/lib/rate-limit/apply';

export const runtime = 'nodejs';

/**
 * POST /api/promo/join/request { phone } — OTP for the ads new-visitor founding
 * path. Dark unless HOLIDAY_PROMO_ENABLED, PROMO_NEW_VISITOR_CHECKOUT_ENABLED,
 * and the founding window are all on.
 *
 * ONE RESPONSE: unknown, STOP, caregiver, and parent all get 200 `{ status:
 * 'accepted' }`. Only the holder of the number can tell whether an SMS arrived.
 */
export async function POST(req: Request): Promise<Response> {
  if (!newVisitorFoundingAllowedFromRequest(req)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { phone?: string } | null;
  const phone = typeof body?.phone === 'string' ? body.phone : '';
  if (!phone) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const phoneE164 = normalizePhoneE164(phone);
  if (!phoneE164) {
    return NextResponse.json({ status: 'accepted' });
  }

  const limited = await enforceRateLimit('claim-phone-send', phoneBlindIndex(phoneE164), true);
  if (limited) return limited;

  const outcome = await requestPromoJoinCode(
    db(),
    { phoneRaw: phoneE164 },
    { sender: createClaimCodeSender() },
  );
  console.info({ outcome: outcome.status }, 'promo-join: code requested');

  return NextResponse.json({ status: 'accepted' });
}
