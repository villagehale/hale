'use server';

import {
  type RequestSmsOtpResult,
  type RevokeSmsChannelResult,
  type VerifySmsOtpResult,
  requestSmsOtp,
  revokeSmsChannelForUser,
  verifySmsOtp,
} from './sms-consent';

/**
 * Thin server actions for the web Settings SMS section — each just forwards to the
 * lib, which owns auth, ip/ua, rate-limiting, and the DB writes (rule #1: identity
 * is resolved server-side, never trusted from the client).
 */

export async function requestSmsOtpAction(phoneRaw: string): Promise<RequestSmsOtpResult> {
  return requestSmsOtp(phoneRaw);
}

export async function verifySmsOtpAction(code: string): Promise<VerifySmsOtpResult> {
  return verifySmsOtp(code);
}

export async function revokeSmsChannelAction(): Promise<RevokeSmsChannelResult> {
  return revokeSmsChannelForUser();
}
