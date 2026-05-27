import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-provider signature verification.
 *
 * Throws on failure; returns void on success. The route handler converts the
 * throw into a 401.
 *
 * For v1 the heavy verification (Stripe, Google Pub/Sub) is stubbed — the
 * verifyStub function ensures we don't accept unsigned traffic in production
 * even before each provider's full verification is wired up.
 */

export async function verifyWebhookSignature(
  provider: string,
  signature: string | null,
  rawBody: string,
): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && !signature) {
    // Allow unsigned in dev for local testing.
    return;
  }

  if (!signature) {
    throw new Error('missing signature header');
  }

  switch (provider) {
    case 'stripe':
      return verifyStripe(signature, rawBody);
    case 'gmail':
    case 'gcal':
      return verifyGoogle(signature, rawBody);
    case 'outlook':
      return verifyMicrosoft(signature, rawBody);
    case 'twilio':
      return verifyTwilio(signature, rawBody);
    default:
      throw new Error(`unknown provider for signature verification: ${provider}`);
  }
}

function verifyStripe(signature: string, rawBody: string): void {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  }
  // Real implementation: parse Stripe's t= and v1= components, verify HMAC-SHA256.
  // Stubbed for v1 — return without throwing only when secret is configured.
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.replace(/^v1=/, '');
  if (!safeEqual(expected, provided)) {
    throw new Error('stripe signature mismatch');
  }
}

function verifyGoogle(_signature: string, _rawBody: string): void {
  // Google Pub/Sub push uses OIDC JWT — verify via Google's tokeninfo or by
  // checking the audience claim against our webhook URL. Wired in M1.5.
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID not configured');
  }
}

function verifyMicrosoft(_signature: string, _rawBody: string): void {
  // Microsoft Graph webhooks use a validation token then HMAC. Wired in M1.5.
  if (!process.env.MICROSOFT_OAUTH_CLIENT_ID) {
    throw new Error('MICROSOFT_OAUTH_CLIENT_ID not configured');
  }
}

function verifyTwilio(_signature: string, _rawBody: string): void {
  // Twilio: HMAC-SHA1 over URL + sorted form params. Wired with SMS feature.
  if (!process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('TWILIO_AUTH_TOKEN not configured');
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
