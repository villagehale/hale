/**
 * Does this email really come from the address it claims? For the email leg that is not
 * a deliverability question, it is the IDENTITY question: the `From` address is what
 * resolves an inbound to a family, so a spoofable `From` is a spoofable family. Every
 * consequence downstream — reading a household's ledger, unsubscribing a parent,
 * speaking to an agent as them — rests on this verdict.
 *
 * WHAT THE PROVIDER DOES NOT GIVE US. The `email.received` webhook carries metadata
 * only — no body, no headers, and no structured SPF/DKIM/DMARC verdict
 * (resend.com/docs/dashboard/receiving/get-email-content). The verdicts exist only as
 * the `Authentication-Results` header the receiving MTA stamped on the message, fetched
 * with the rest of the headers. So this module parses RFC 8601 rather than reading a
 * field, and "there was no verdict to read" is a first-class outcome rather than a
 * default.
 *
 * DKIM IS THE ANCHOR, NOT SPF. Hale's public address is forwarded in by a third party.
 * Forwarding rewrites the envelope sender, so SPF legitimately FAILS for ordinary mail
 * from real parents, while DKIM — a signature over the message itself — survives
 * intact. A gate built on SPF would reject essentially all production traffic; a gate
 * built on an aligned DKIM pass rejects spoofs and passes forwarded mail. That is why
 * `spf` is parsed and reported but never decides.
 *
 * ALIGNMENT IS THE POINT. A DKIM pass alone says only "somebody signed this and the
 * signature checks out" — a bulk sender's own signature passes on a message claiming
 * any `From` it likes. What makes the `From` trustworthy is that the SIGNING domain is
 * the From domain (or its organizational parent). That is DMARC's alignment test,
 * computed here from DKIM so it holds under forwarding.
 *
 * ONLY OUR OWN MTA'S VERDICT COUNTS. `Authentication-Results` is an ordinary header:
 * anyone can put one in the message they send, saying anything. Only the copy stamped
 * by our own receiving MTA means anything, so the authserv-id must match the configured
 * one exactly — and every other copy, including one an attacker prepended, is skipped.
 * Getting this wrong turns the whole module into a rubber stamp the sender controls.
 *
 * FAILS CLOSED, AND THE CALLER DECIDES WHAT THAT COSTS. An untrusted message is never
 * resolved to an existing family (see identity.ts). It is not necessarily discarded —
 * treating an unverifiable stranger as a stranger is a legitimate choice — but it can
 * never BE somebody.
 */

/** An RFC 8601 method result. `none` means "nothing to check", which is not a pass. */
export type AuthVerdict = 'pass' | 'fail' | 'none' | 'neutral' | 'softfail' | 'temperror' | 'permerror';

export interface AuthenticationResults {
  /** Which MTA stamped this verdict. The only thing that makes it worth reading. */
  authservId: string;
  spf: AuthVerdict | null;
  dkim: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  /** Every `header.d=` signing domain, lowercased, in header order. */
  dkimDomains: readonly string[];
}

export type SenderTrust =
  | { trusted: true; basis: 'dkim_aligned' }
  | { trusted: false; reason: TrustFailure };

/** Why a sender could not be trusted. An enum, never free text: it is logged and
 * counted, so it must be safe to emit and stable to aggregate on (rule #1). */
export type TrustFailure =
  /** No `Authentication-Results` from our own MTA — nothing authentic to read. */
  | 'no_trusted_verdict'
  /** Our MTA checked, and the signature did not verify (or there was none). */
  | 'dkim_failed'
  /** A real signature, but by a domain that is not the sender's. */
  | 'dkim_not_aligned';

const VERDICTS: ReadonlySet<string> = new Set([
  'pass',
  'fail',
  'none',
  'neutral',
  'softfail',
  'temperror',
  'permerror',
]);

function asVerdict(raw: string | undefined): AuthVerdict | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  return VERDICTS.has(value) ? (value as AuthVerdict) : null;
}

/**
 * Parse one `Authentication-Results` header value. Returns null when there is no
 * authserv-id, because a verdict we cannot attribute to an MTA is a verdict we cannot
 * use.
 */
export function parseAuthenticationResults(header: string): AuthenticationResults | null {
  // Unfold first: a long header arrives wrapped across lines with leading whitespace.
  const unfolded = header.replace(/\r?\n[ \t]+/g, ' ').trim();
  if (!unfolded) return null;

  const [authservRaw, ...rest] = unfolded.split(';');
  const authservId = (authservRaw ?? '').trim().split(/\s+/)[0] ?? '';
  if (!authservId) return null;

  const dkimDomains: string[] = [];
  let spf: AuthVerdict | null = null;
  let dkim: AuthVerdict | null = null;
  let dmarc: AuthVerdict | null = null;

  for (const clause of rest) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    const method = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(trimmed);
    if (!method) continue;

    const verdict = asVerdict(method[2]);
    // The FIRST verdict per method wins. A message can carry several DKIM results (one
    // per signature); the domains are all collected below, but the headline verdict is
    // not overwritten by a later clause.
    switch (method[1]?.toLowerCase()) {
      case 'spf':
        spf ??= verdict;
        break;
      case 'dkim': {
        dkim ??= verdict;
        const domain = /header\.d\s*=\s*([^\s;]+)/i.exec(trimmed);
        if (domain?.[1]) dkimDomains.push(domain[1].toLowerCase());
        break;
      }
      case 'dmarc':
        dmarc ??= verdict;
        break;
    }
  }

  return { authservId, spf, dkim, dmarc, dkimDomains };
}

/**
 * Whether `signing` may vouch for `fromDomain`: the same domain, or a SUBDOMAIN of it.
 * `mail.example.com` signing for `example.com` aligns; `notexample.com` does not.
 *
 * Two deliberate narrowings, each closing a spoof:
 *
 * A plain `endsWith` would align `notexample.com` with `example.com` — precisely the
 * shape a spoofer registers. The dot makes the comparison label-wise.
 *
 * The OTHER direction — letting an ancestor domain sign for a subdomain, which is what
 * relaxed DMARC alignment permits — is refused, because doing it correctly needs the
 * Public Suffix List and doing it naively is a hole. Without a PSL, `d=appspot.com`
 * would vouch for `From: victim@victim.appspot.com`, and `d=com` would vouch for
 * everything: any shared-hosting parent domain an attacker can obtain a signature from
 * becomes a signature for every tenant beneath it. Requiring the signer to sit at or
 * BELOW the From domain removes that class outright rather than guarding each instance
 * of it — a signer inside the From domain's own DNS tree already controls it.
 *
 * The cost is a sender whose From is a subdomain but whose DKIM is signed by the parent
 * (`From: @mail.example.com`, `d=example.com`). That is rare for the personal mailboxes
 * this leg serves, and it fails CLOSED and NAMED (`dkim_not_aligned`), so it shows up as
 * a logged refusal we can see rather than as mail that silently disappears.
 */
function domainsAlign(signing: string, fromDomain: string): boolean {
  if (!signing || !fromDomain) return false;
  return signing === fromDomain || signing.endsWith(`.${fromDomain}`);
}

/** Our own MTA's verdict, out of however many copies the message carries. */
function trustedResults(
  headers: Readonly<Record<string, string>>,
  authservId: string,
): AuthenticationResults | null {
  const raw = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authentication-results',
  )?.[1];
  if (!raw) return null;

  const wanted = authservId.toLowerCase();
  // Several hops may each have stamped one; a provider that collapses duplicate headers
  // joins them with a newline. Unfolding happens per-candidate inside the parser, so the
  // split is on newlines that are NOT continuations.
  for (const candidate of raw.split(/\r?\n(?![ \t])/)) {
    const parsed = parseAuthenticationResults(candidate);
    if (parsed && parsed.authservId.toLowerCase() === wanted) {
      return parsed;
    }
  }
  return null;
}

/**
 * The verdict on one inbound message's sender.
 *
 * `headers` is the header map from the received-email API; `fromDomain` is the domain of
 * the parsed `From` address; `authservId` is our own receiving MTA's identity, which
 * MUST come from configuration rather than from the message.
 */
export function assessSenderTrust(input: {
  headers: Readonly<Record<string, string>>;
  authservId: string;
  fromDomain: string;
}): SenderTrust {
  const results = trustedResults(input.headers, input.authservId);
  if (!results) {
    return { trusted: false, reason: 'no_trusted_verdict' };
  }
  if (results.dkim !== 'pass') {
    return { trusted: false, reason: 'dkim_failed' };
  }

  const fromDomain = input.fromDomain.toLowerCase();
  const aligned = results.dkimDomains.some((signing) => domainsAlign(signing, fromDomain));
  return aligned
    ? { trusted: true, basis: 'dkim_aligned' }
    : { trusted: false, reason: 'dkim_not_aligned' };
}
