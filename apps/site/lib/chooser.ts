/**
 * The /text chooser's channel matrix — which messaging pipes the page offers,
 * and in what order, per platform (F14 messaging-first funnel).
 *
 * Two laws, both load-bearing:
 *
 *  - LIVENESS GATES. A channel whose env is unset is not in the returned list at
 *    all — no disabled button, no "coming soon" (the Connections-card law, #585).
 *    The inputs are the already-validated reads: readSmsNumber /
 *    readWhatsAppNumber (lib/text-entry.ts).
 *  - THE UA HINT ORDERS, NEVER GATES a live mobile channel. An Android user still
 *    sees and can tap Messages — it is merely second. The one deliberate
 *    withholding is `sms:` on non-Apple DESKTOP (and unknown), where the link is
 *    a silent no-op on Windows/Linux: there the QR of the same URI is the path,
 *    which any phone can scan — so the reader loses no door, only a dead button.
 *
 * Honest naming: the channel is `messages`, never "iMessage" — `sms:` opens the
 * app literally named Messages on both iPhone and Android. When Apple Messages
 * for Business ships (VIL-335), config swaps this channel's HREF (a new env) and
 * nothing here changes shape.
 */

export type ChannelId = 'messages' | 'whatsapp';

export type Platform = 'apple' | 'android' | 'desktop-mac' | 'desktop-other' | 'unknown';

/**
 * A user-agent string as a coarse platform HINT — ordering input only. Parsed
 * with three fixed probes rather than a UA library: the failure mode of a miss
 * is a suboptimal ordering, never a lost path. `null` (no header, or a render
 * outside request scope) is its own value, treated like an unknown desktop
 * because the QR works everywhere.
 */
export function platformFromUa(ua: string | null): Platform {
  if (ua === null) return 'unknown';
  if (/iPhone|iPad/.test(ua)) return 'apple';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua)) return 'desktop-mac';
  return 'desktop-other';
}

/**
 * The channels the chooser renders, primary first. Empty is a real state: SMS
 * env unset entirely is the caller's email-fallback branch, and a non-Apple
 * desktop with WhatsApp dark offers the QR alone.
 */
export function channelOrder(
  platform: Platform,
  live: { sms: boolean; wa: boolean },
): ChannelId[] {
  const messages: ChannelId[] = live.sms ? ['messages'] : [];
  const whatsapp: ChannelId[] = live.wa ? ['whatsapp'] : [];
  switch (platform) {
    // iPhone/iPad: sms: opens Apple Messages natively — the home-court pipe.
    case 'apple':
      return [...messages, ...whatsapp];
    // Android leads with WhatsApp where it is live; Messages stays one tap away.
    case 'android':
      return [...whatsapp, ...messages];
    // macOS is the one desktop where sms: really opens a composer (Messages.app),
    // and wa.me opens WhatsApp Web beside it.
    case 'desktop-mac':
      return [...messages, ...whatsapp];
    // Windows/Linux/unknown: sms: is a dead link, so Messages is never a button
    // here — the QR card leads instead, and WhatsApp (Web) is offered when live.
    case 'desktop-other':
    case 'unknown':
      return [...whatsapp];
  }
}

/** Where the desktop QR card sits: on non-Apple desktop (and unknown) it IS the
 * hero and renders above the buttons; elsewhere it trails them. */
export function qrLeads(platform: Platform): boolean {
  return platform === 'desktop-other' || platform === 'unknown';
}
