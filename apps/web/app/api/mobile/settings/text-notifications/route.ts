import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import {
  loadSmsChannel,
  requestSmsOtp,
  revokeSmsChannelForUser,
  verifySmsOtp,
} from '~/lib/channels/sms-consent';
import type {
  MobileTextChannelResponse,
  MobileTextOtpRequest,
  MobileTextOtpRequestResponse,
  MobileTextRevokeResponse,
  MobileTextVerifyRequest,
  MobileTextVerifyResponse,
} from '../../types';

export const runtime = 'nodejs';

/**
 * The native Settings SMS-channel screen (VIL-212). All four verbs delegate to the
 * shared lib, which resolves the caller's family (rule #1), applies the fail-closed
 * rate limits, and writes consent + audit (rule #6). Auth() is the 401 gate — the
 * Edge middleware bridges the Bearer token to a session, so a signed-in app caller
 * resolves through the same path as web.
 *
 *   GET    — current enrolment state + whether SMS is provisioned yet
 *   POST   — request an OTP for a phone number
 *   PATCH  — verify a code (records CASL consent on success)
 *   DELETE — revoke the channel
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const result = await loadSmsChannel();
  switch (result.status) {
    case 'ready':
      return NextResponse.json({
        enrolled: result.channel.enrolled,
        maskedPhone: result.channel.maskedPhone,
        senderConfigured: result.senderConfigured,
      } satisfies MobileTextChannelResponse);
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as MobileTextOtpRequest | null;
  if (!body || typeof body.phone !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await requestSmsOtp(body.phone);
  switch (result.status) {
    case 'sent':
      return NextResponse.json({
        status: 'sent',
        maskedPhone: result.maskedPhone,
      } satisfies MobileTextOtpRequestResponse);
    case 'not_configured':
    case 'invalid_phone':
      return NextResponse.json({ status: result.status } satisfies MobileTextOtpRequestResponse);
    case 'cooldown':
      return NextResponse.json({
        status: 'cooldown',
        retryAfterMs: result.retryAfterMs,
      } satisfies MobileTextOtpRequestResponse);
    case 'rate_limited':
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as MobileTextVerifyRequest | null;
  if (!body || typeof body.code !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await verifySmsOtp(body.code);
  switch (result.status) {
    case 'verified':
      return NextResponse.json({
        status: 'verified',
        maskedPhone: result.maskedPhone,
      } satisfies MobileTextVerifyResponse);
    case 'wrong_code':
      return NextResponse.json({
        status: 'wrong_code',
        attemptsRemaining: result.attemptsRemaining,
      } satisfies MobileTextVerifyResponse);
    case 'locked':
    case 'expired':
    case 'no_pending':
      return NextResponse.json({ status: result.status } satisfies MobileTextVerifyResponse);
    case 'rate_limited':
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}

export async function DELETE(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const result = await revokeSmsChannelForUser();
  switch (result.status) {
    case 'revoked':
    case 'not_found':
      return NextResponse.json({ status: result.status } satisfies MobileTextRevokeResponse);
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    default:
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
