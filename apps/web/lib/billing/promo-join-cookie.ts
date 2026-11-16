import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived binding from a verified founding-join OTP to Stripe Checkout.
 * Signed with AUTH_SECRET so /api/promo/join/checkout can trust it without
 * minting an Auth.js session (the parent has not texted Hale yet).
 */

export const PROMO_JOIN_COOKIE = 'hale_promo_join';
export const PROMO_JOIN_TTL_SECONDS = 15 * 60;

export interface PromoJoinBinding {
  familyId: string;
  userId: string;
  externalAuthId: string;
}

interface SignedPayload extends PromoJoinBinding {
  exp: number;
}

function secretFrom(env: Record<string, string | undefined>): string | null {
  const s = env.AUTH_SECRET?.trim();
  return s ? s : null;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signPromoJoinBinding(
  binding: PromoJoinBinding,
  env: Record<string, string | undefined> = process.env,
  opts: { ttlSeconds?: number; now?: number } = {},
): string | null {
  const secret = secretFrom(env);
  if (!secret) return null;
  const exp = (opts.now ?? Date.now()) + (opts.ttlSeconds ?? PROMO_JOIN_TTL_SECONDS) * 1000;
  const payload: SignedPayload = { ...binding, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function readPromoJoinBinding(
  token: string | undefined,
  env: Record<string, string | undefined> = process.env,
  opts: { now?: number } = {},
): PromoJoinBinding | null {
  const secret = secretFrom(env);
  if (!secret || !token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body, secret));
  const provided = Buffer.from(mac);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }
  let payload: SignedPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
  } catch {
    return null;
  }
  if ((opts.now ?? Date.now()) > payload.exp) return null;
  if (!payload.familyId || !payload.userId || !payload.externalAuthId) return null;
  return {
    familyId: payload.familyId,
    userId: payload.userId,
    externalAuthId: payload.externalAuthId,
  };
}
