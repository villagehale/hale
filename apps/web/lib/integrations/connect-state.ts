import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConnectorProvider } from './google-oauth';

/**
 * The OAuth `state` for a connector connect flow — a signed, self-contained token
 * that binds the consent redirect to the family + user + provider that started it.
 * Signed (HMAC-SHA256 over AUTH_SECRET) so the callback can trust it without
 * server-side session storage, and time-boxed so a leaked URL can't be replayed
 * later. This is CSRF protection AND the binding that stops a connected token
 * from ever being attributed to the wrong family (rule #1).
 */
export interface ConnectState {
  familyId: string;
  userId: string;
  provider: ConnectorProvider;
}

interface SignedPayload extends ConnectState {
  exp: number;
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET is not set — cannot sign connector connect state');
  return s;
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

export function signConnectState(
  state: ConnectState,
  opts: { ttlSeconds?: number; now?: number } = {},
): string {
  const exp = (opts.now ?? Date.now()) + (opts.ttlSeconds ?? 600) * 1000;
  const payload: SignedPayload = { ...state, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyConnectState(token: string, opts: { now?: number } = {}): ConnectState {
  const [body, mac] = token.split('.');
  if (!body || !mac) throw new Error('malformed connect state');
  const expected = Buffer.from(sign(body));
  const provided = Buffer.from(mac);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error('connect state signature mismatch');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
  if ((opts.now ?? Date.now()) > payload.exp) {
    throw new Error('connect state expired');
  }
  const { exp: _exp, ...state } = payload;
  return state;
}
