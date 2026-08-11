import { describe, expect, it } from 'vitest';
import { assessSenderTrust, parseAuthenticationResults } from './trust';

const MX = 'mx.resend.com';

describe('parseAuthenticationResults', () => {
  it('reads spf, dkim and dmarc verdicts out of an RFC 8601 header', () => {
    const header = `${MX}; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com header.s=sel; dmarc=pass header.from=example.com`;
    expect(parseAuthenticationResults(header)).toEqual({
      authservId: MX,
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      dkimDomains: ['example.com'],
    });
  });

  it('reads a fail verdict as a fail, not as an absence', () => {
    const header = `${MX}; spf=fail smtp.mailfrom=evil.test; dkim=fail header.d=evil.test; dmarc=fail header.from=bank.test`;
    const parsed = parseAuthenticationResults(header);
    expect(parsed?.spf).toBe('fail');
    expect(parsed?.dkim).toBe('fail');
    expect(parsed?.dmarc).toBe('fail');
  });

  it('reports a method that is absent as null rather than inventing a pass', () => {
    const parsed = parseAuthenticationResults(`${MX}; spf=pass smtp.mailfrom=example.com`);
    expect(parsed?.spf).toBe('pass');
    expect(parsed?.dkim).toBeNull();
    expect(parsed?.dmarc).toBeNull();
  });

  it('collects every dkim signature domain when a message is signed more than once', () => {
    const header = `${MX}; dkim=pass header.d=example.com; dkim=pass header.d=mailer.example.net`;
    expect(parseAuthenticationResults(header)?.dkimDomains).toEqual([
      'example.com',
      'mailer.example.net',
    ]);
  });

  it('lowercases the domains so alignment is not case-sensitive', () => {
    const header = `${MX}; dkim=pass header.d=EXAMPLE.COM`;
    expect(parseAuthenticationResults(header)?.dkimDomains).toEqual(['example.com']);
  });

  it('tolerates folded whitespace and newlines', () => {
    const header = `${MX};\r\n  spf=pass smtp.mailfrom=example.com;\r\n  dkim=pass header.d=example.com`;
    const parsed = parseAuthenticationResults(header);
    expect(parsed?.authservId).toBe(MX);
    expect(parsed?.dkim).toBe('pass');
  });

  it('returns null for a header with no authserv-id to attribute it to', () => {
    expect(parseAuthenticationResults('')).toBeNull();
    expect(parseAuthenticationResults('   ')).toBeNull();
  });

  /** `none` is a real RFC 8601 verdict meaning "no signature to check" — it is not a
   * pass, and folding it into one would trust every unsigned message. */
  it('keeps `none` distinct from `pass`', () => {
    expect(parseAuthenticationResults(`${MX}; dkim=none`)?.dkim).toBe('none');
  });
});

describe('assessSenderTrust', () => {
  const trusted = { authservId: MX, fromDomain: 'example.com' };

  function header(value: string | undefined): Readonly<Record<string, string>> {
    return value === undefined ? {} : { 'authentication-results': value };
  }

  it('trusts a message whose DKIM passes and whose signing domain is the From domain', () => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com`),
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: true, basis: 'dkim_aligned' });
  });

  /**
   * THE FORWARDING CASE, and the reason DKIM rather than SPF is the anchor. Hale's
   * public address is forwarded by a third party, which rewrites the envelope sender —
   * so SPF legitimately fails for ordinary mail from real parents. Rejecting on SPF
   * would reject essentially all production traffic.
   */
  it('trusts an aligned DKIM pass even when SPF failed, because forwarding breaks SPF', () => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; spf=fail smtp.mailfrom=forwarder.test; dkim=pass header.d=example.com`),
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: true, basis: 'dkim_aligned' });
  });

  it('accepts a signature from a subdomain of the From domain', () => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; dkim=pass header.d=mail.example.com`),
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: true, basis: 'dkim_aligned' });
  });

  /**
   * The public-suffix hole, closed by construction. Relaxed DMARC would let an ANCESTOR
   * domain sign for a subdomain, but computing "organizational domain" correctly needs
   * the Public Suffix List — and without one, a signature from any shared-hosting parent
   * becomes a signature for every tenant beneath it.
   */
  it.each([
    ['com', 'example.com'],
    ['co.uk', 'victim.co.uk'],
    ['appspot.com', 'victim.appspot.com'],
  ])('refuses an ancestor domain (d=%s) vouching for a subdomain sender', (signing, from) => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; dkim=pass header.d=${signing}`),
      authservId: MX,
      fromDomain: from,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'dkim_not_aligned' });
  });

  it('refuses a DKIM pass signed by an unrelated domain — a valid signature is not alignment', () => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; dkim=pass header.d=bulk-sender.test`),
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'dkim_not_aligned' });
  });

  it('refuses a DKIM fail', () => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; dkim=fail header.d=example.com`),
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'dkim_failed' });
  });

  it('refuses an unsigned message', () => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; spf=pass smtp.mailfrom=example.com; dkim=none`),
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'dkim_failed' });
  });

  /**
   * THE SPOOF. Anyone can type an `Authentication-Results` header into the message they
   * send; only our own receiving MTA's copy means anything. A verifier that reads any
   * A-R header it finds can be handed `dkim=pass header.d=<victim>` by the attacker.
   */
  it('ignores an Authentication-Results header stamped by anyone but our own MTA', () => {
    const verdict = assessSenderTrust({
      headers: header('attacker-controlled; dkim=pass header.d=example.com'),
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'no_trusted_verdict' });
  });

  it('picks our MTA’s verdict out of a list of hops, ignoring another MTA’s', () => {
    const verdict = assessSenderTrust({
      headers: {
        'authentication-results': [
          'evil.test; dkim=pass header.d=example.com',
          `${MX}; dkim=fail header.d=example.com`,
        ].join('\n'),
      },
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'dkim_failed' });
  });

  /**
   * A sender who writes their own `Authentication-Results` claiming OUR authserv-id
   * produces a second copy. We cannot tell it from the real one by content — that is the
   * point of the forgery — so two is no verdict at all, whichever order they arrive in.
   */
  it.each([
    ['forged after', [`${MX}; dkim=fail header.d=example.com`, `${MX}; dkim=pass header.d=example.com`]],
    ['forged before', [`${MX}; dkim=pass header.d=example.com`, `${MX}; dkim=fail header.d=example.com`]],
  ])('refuses when our authserv-id appears twice (%s)', (_label, copies) => {
    const verdict = assessSenderTrust({
      headers: { 'authentication-results': copies.join('\n') },
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'no_trusted_verdict' });
  });

  it('still accepts a single verdict that arrives folded across lines', () => {
    const verdict = assessSenderTrust({
      headers: { 'authentication-results': `${MX};\r\n  dkim=pass header.d=example.com` },
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: true, basis: 'dkim_aligned' });
  });

  it('names the absence of any verdict rather than treating it as a pass or a fail', () => {
    expect(assessSenderTrust({ headers: header(undefined), ...trusted })).toEqual({
      trusted: false,
      reason: 'no_trusted_verdict',
    });
  });

  it('matches the Authentication-Results header name case-insensitively', () => {
    const verdict = assessSenderTrust({
      headers: { 'Authentication-Results': `${MX}; dkim=pass header.d=example.com` },
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: true, basis: 'dkim_aligned' });
  });

  it('compares the authserv-id case-insensitively but never by prefix', () => {
    expect(
      assessSenderTrust({
        headers: header('MX.RESEND.COM; dkim=pass header.d=example.com'),
        ...trusted,
      }),
    ).toEqual({ trusted: true, basis: 'dkim_aligned' });

    expect(
      assessSenderTrust({
        headers: header(`${MX}.evil.test; dkim=pass header.d=example.com`),
        ...trusted,
      }),
    ).toEqual({ trusted: false, reason: 'no_trusted_verdict' });
  });

  it('refuses when the From domain is unknown, since nothing can be aligned against it', () => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; dkim=pass header.d=example.com`),
      authservId: MX,
      fromDomain: '',
    });
    expect(verdict).toEqual({ trusted: false, reason: 'dkim_not_aligned' });
  });

  /** A one-label suffix match would make `notexample.com` align with `example.com`. */
  it('does not let a domain that merely ends with the From domain align', () => {
    const verdict = assessSenderTrust({
      headers: header(`${MX}; dkim=pass header.d=notexample.com`),
      ...trusted,
    });
    expect(verdict).toEqual({ trusted: false, reason: 'dkim_not_aligned' });
  });
});
