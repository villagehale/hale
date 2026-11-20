/**
 * The public https URL checks inbound media and photo facts share. No imports, so the
 * inbound-photo-facts eval runs the read contract that uses them as-is.
 */

export function httpsMediaUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

/**
 * Devin SEC_0001: a `.vcf` URL comes from the webhook payload, so the fetch must not
 * reach a loopback, private, link-local, or metadata host. IP literals in those ranges
 * and internal-looking names are refused. Redirects are followed by hand so every hop
 * is checked again.
 */
export function publicMediaUrl(raw: string | null | undefined): string | null {
  const url = httpsMediaUrl(raw);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return null;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) {
    return null;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return null;
    }
    return url;
  }
  if (host.includes(':')) {
    // Any IPv6 literal: loopback, ULA, link-local, and v4-mapped forms are all refused;
    // a real media host is a DNS name.
    return null;
  }
  // Numeric-looking hosts that are not dotted quads (e.g. 2130706433, 0x7f.1) are refused.
  if (/^[\d.x]+$/i.test(host) || /^0x/i.test(host)) return null;
  return url;
}
