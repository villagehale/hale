import { NextResponse } from 'next/server';
import { authConfigured } from '~/lib/auth-config';
import { requestClaimCode } from '~/lib/auth/claim-by-phone';
import { createClaimCodeSender } from '~/lib/auth/claim-code-sender';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { db } from '~/lib/db';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { enforceRateLimit } from '~/lib/rate-limit/apply';

export const runtime = 'nodejs';

/**
 * POST /api/auth/claim-phone/request { phone } — text a sign-in code to a number that
 * already owns an account here (a family that arrived by SMS intake).
 *
 * ONE RESPONSE, ALWAYS. An unknown number, a number that texted STOP, a caregiver's
 * number and a parent's all get the identical 200 `{ status: 'accepted' }`. The only
 * thing that differs is whether an SMS arrives, which only the holder of the number can
 * observe (rule #1 — this endpoint is unauthenticated, so confirming that a number has
 * an account would hand a stranger a household-membership oracle). The core's distinct
 * outcomes are logged server-side and collapse here.
 *
 * DARK BY DEFAULT with the sign-in page it belongs to: off, the route does not exist,
 * so the UI and the endpoint can never disagree about whether the door is open.
 *
 * TWO LIMITS, different jobs. Per-IP is the shared auth window — one source cannot walk
 * a list of numbers. Per-NUMBER (keyed on the blind index, never the raw number) is the
 * one that costs money: it bounds SMS-pumping at a number the caller may not even hold.
 */
export async function POST(req: Request): Promise<Response> {
  if (!receiptsIaEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!authConfigured()) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as { phone?: string } | null;
  const phone = typeof body?.phone === 'string' ? body.phone : '';
  if (!phone) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // A number that isn't a number cannot be rate-limited by number, and there is nothing
  // to send it either. Answered like everything else; the per-IP limit above is what
  // bounds a caller who only ever sends junk.
  const phoneE164 = normalizePhoneE164(phone);
  if (!phoneE164) {
    return NextResponse.json({ status: 'accepted' });
  }

  const limited = await enforceRateLimit('claim-phone-send', phoneBlindIndex(phoneE164), true);
  if (limited) return limited;

  const outcome = await requestClaimCode(db(), { phoneRaw: phoneE164 }, {
    sender: createClaimCodeSender(),
  });
  // The label only — never the number, and never in the response body.
  console.info({ outcome: outcome.status }, 'claim-by-phone: code requested');

  return NextResponse.json({ status: 'accepted' });
}
