import { MARKETING_SITE_URL } from '~/lib/legal-links';

/**
 * Device half of a portal "Text Hale" door. The probes match
 * apps/site/lib/chooser.ts `platformFromUa` — iPhone, iPad, and Mac open
 * Messages, Android opens its composer, and anything else stays on the
 * marketing /text page.
 */
export type MessagesPlatform = 'apple' | 'android' | 'desktop-mac' | 'desktop-other' | 'unknown';

const SOURCE_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_CODE_MAX_LENGTH = 48;

/** Locked English hello. Byte-locked to apps/site INTAKE_PREFILL. */
export const PORTAL_INTAKE_PREFILL = "Hey Hale, what's going on?";

export function platformFromUa(ua: string | null): MessagesPlatform {
  if (ua === null) return 'unknown';
  if (/iPhone|iPad/.test(ua)) return 'apple';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua)) return 'desktop-mac';
  return 'desktop-other';
}

export function messagesCapable(platform: MessagesPlatform): boolean {
  return platform === 'apple' || platform === 'android' || platform === 'desktop-mac';
}

/** Same grammar as the marketing site's `?s=` validator. Odd codes are dropped. */
export function parsePortalSourceCode(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > SOURCE_CODE_MAX_LENGTH) return null;
  return SOURCE_CODE_PATTERN.test(raw) ? raw : null;
}

export function textPageHref(source: string | null): string {
  return source ? `${MARKETING_SITE_URL}/text?s=${source}` : `${MARKETING_SITE_URL}/text`;
}

function encodeComposerBody(body: string): string {
  return encodeURIComponent(body).replaceAll("'", '%27');
}

/**
 * `prefill === null` opens the thread with no body (the portal home button).
 * A string is the composer hello, plus `(via <code>)` when a source survived.
 */
export function selectTextHaleHref(input: {
  platform: MessagesPlatform;
  smsNumber: string;
  prefill: string | null;
  source: string | null;
}): { href: string; composer: boolean } {
  const fallback = textPageHref(input.source);
  if (!messagesCapable(input.platform) || input.smsNumber === '') {
    return { href: fallback, composer: false };
  }
  if (input.prefill === null) {
    return { href: `sms:${input.smsNumber}`, composer: true };
  }
  const body = input.source ? `${input.prefill} (via ${input.source})` : input.prefill;
  const encoded = encodeComposerBody(body);
  if (input.platform === 'android') {
    return { href: `sms:${input.smsNumber}?body=${encoded}`, composer: true };
  }
  return { href: `sms:${input.smsNumber}&body=${encoded}`, composer: true };
}
