import type { Database } from '@hale/db';
import { headers } from 'next/headers';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { enforceRateLimit } from '~/lib/rate-limit/apply';
import { createOtpSender, isOtpSenderConfigured } from './otp-sender';
import {
  type RevokeChannelResult,
  type SmsChannelState,
  loadSmsChannelState,
  requestPhoneOtp,
  revokeSmsChannel,
  verifyPhoneOtp,
} from './sms-consent-core';

/**
 * Request/auth wrapper over the SMS enrolment engine (./sms-consent-core). Resolves
 * the signed-in parent (never a fabricated id — rule #1), pulls the request's IP +
 * user-agent for the CASL consent record, and applies the fail-closed rate limits.
 * The core owns the DB writes; this layer owns identity, ip/ua, and throttling. The
 * degradation boundaries mirror the push-prefs lib: `preview` (auth/DB unconfigured
 * here), `unauthenticated` (configured but signed out), `not_found` (signed in but
 * no family yet).
 */

type CtxFail = { status: 'preview' } | { status: 'unauthenticated' } | { status: 'not_found' };
type ChannelContext =
  | { status: 'ready'; database: Database; userId: string; familyId: string }
  | CtxFail;

async function channelContext(): Promise<ChannelContext> {
  if (!process.env.DATABASE_URL || !authConfigured()) {
    return { status: 'preview' };
  }
  const session = await auth();
  const externalAuthId = session?.user?.id;
  const email = session?.user?.email;
  if (!externalAuthId || !email) {
    return { status: 'unauthenticated' };
  }

  const database = defaultDb();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(
    { externalAuthId, email, name: session.user?.name ?? null },
    database,
  );
  return { status: 'ready', database, userId, familyId };
}

/** IP + user-agent of the request being handled, for the CASL consent record. */
async function requestMeta(): Promise<{ ip: string | undefined; userAgent: string | undefined }> {
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
  const userAgent = h.get('user-agent') ?? undefined;
  return { ip, userAgent };
}

export type LoadSmsChannelResult =
  | { status: 'ready'; channel: SmsChannelState; senderConfigured: boolean }
  | CtxFail;

export async function loadSmsChannel(): Promise<LoadSmsChannelResult> {
  const ctx = await channelContext();
  if (ctx.status !== 'ready') return ctx;
  const channel = await loadSmsChannelState(ctx.database, ctx.userId);
  return { status: 'ready', channel, senderConfigured: isOtpSenderConfigured() };
}

export type RequestSmsOtpResult =
  | { status: 'sent'; maskedPhone: string }
  | { status: 'not_configured' }
  | { status: 'invalid_phone' }
  | { status: 'cooldown'; retryAfterMs: number }
  | { status: 'rate_limited' }
  | CtxFail;

export async function requestSmsOtp(phoneRaw: string): Promise<RequestSmsOtpResult> {
  const ctx = await channelContext();
  if (ctx.status !== 'ready') return ctx;

  if (await enforceRateLimit('sms-otp-send', ctx.userId, true)) {
    return { status: 'rate_limited' };
  }

  return requestPhoneOtp(ctx.database, { userId: ctx.userId, phoneRaw }, { sender: createOtpSender() });
}

export type VerifySmsOtpResult =
  | { status: 'verified'; maskedPhone: string }
  | { status: 'wrong_code'; attemptsRemaining: number }
  | { status: 'locked' }
  | { status: 'expired' }
  | { status: 'no_pending' }
  | { status: 'rate_limited' }
  | CtxFail;

export async function verifySmsOtp(code: string): Promise<VerifySmsOtpResult> {
  const ctx = await channelContext();
  if (ctx.status !== 'ready') return ctx;

  if (await enforceRateLimit('sms-otp-verify', ctx.userId, true)) {
    return { status: 'rate_limited' };
  }

  const { ip, userAgent } = await requestMeta();
  return verifyPhoneOtp(
    ctx.database,
    { userId: ctx.userId, familyId: ctx.familyId, code, ip, userAgent },
    { sender: createOtpSender() },
  );
}

export type RevokeSmsChannelResult = RevokeChannelResult | CtxFail;

export async function revokeSmsChannelForUser(): Promise<RevokeSmsChannelResult> {
  const ctx = await channelContext();
  if (ctx.status !== 'ready') return ctx;

  const { ip, userAgent } = await requestMeta();
  return revokeSmsChannel(ctx.database, {
    userId: ctx.userId,
    familyId: ctx.familyId,
    ip,
    userAgent,
  });
}
