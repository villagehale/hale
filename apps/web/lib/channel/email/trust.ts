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
 *
 * THE ONE ASSUMPTION THIS RESTS ON, WRITTEN DOWN BECAUSE IT IS NOT OURS TO ENFORCE. The
 * parser treats `;` as a real clause boundary, which means it trusts the receiving MTA to
 * SANITIZE the attacker-controlled parts of a DKIM signature before quoting them into the
 * header it writes. The `i=` AUID's local part, a selector, and CFWS comments all
 * originate with the sender; if any were reflected with a raw `;` intact, a sender could
 * smuggle `…; dkim=pass header.d=<victim>` INTO our own MTA's verdict, and after the
 * split that fragment is indistinguishable from a genuine passing signature. No
 * parser-side rule can tell the two apart — the injected fragment is well-formed — so
 * this is the MTA's job, and RFC 8601 §7.1 requires exactly that sanitization of it. A
 * compliant provider is safe; ours must be CONFIRMED by probing a hostile `i=` against a
 * real delivered message before this leg is enabled, alongside the authserv-id check
 * config.ts already calls for.
 */

/** An RFC 8601 method result. `none` means "nothing to check", which is not a pass. */
export type AuthVerdict = 'pass' | 'fail' | 'none' | 'neutral' | 'softfail' | 'temperror' | 'permerror';

/**
 * One evaluated DKIM signature: its verdict and the domain that signed it, kept
 * TOGETHER.
 *
 * They are a pair, and separating them is a vulnerability rather than a simplification.
 * A message may carry several signatures, and RFC 8601 has the MTA report one result per
 * signature, failures included. Reduce that to a single headline verdict plus a flat list
 * of domains and the two can be read from different signatures — so a valid signature by
 * a domain the attacker owns lends its `pass` to the victim's domain named in a FAILED
 * one. The type makes that unsayable.
 */
export interface DkimSignatureResult {
  verdict: AuthVerdict;
  /** The `header.d=` signing domain, lowercased, or null when the clause named none. */
  domain: string | null;
}

export interface AuthenticationResults {
  /** Which MTA stamped this verdict. The only thing that makes it worth reading. */
  authservId: string;
  spf: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  /** One entry per evaluated signature, in header order. */
  dkim: readonly DkimSignatureResult[];
}

export type SenderTrust =
  | { trusted: true; basis: 'dkim_aligned' }
  /** No verdict from our own MTA. Carries every authserv-id the header DID claim, in
   * order and with duplicates kept: a mismatch tells the operator what the MTA really
   * stamps (provisioning reads this instead of a dashboard), and our own id twice is
   * how a sender-forged copy shows up. MTA hostnames only — never message content. */
  | {
      trusted: false;
      reason: 'no_trusted_verdict';
      observedAuthservIds: readonly string[];
    }
  | { trusted: false; reason: Exclude<TrustFailure, 'no_trusted_verdict'> };

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
 * The signing domain of one DKIM clause.
 *
 * `header.d` is the signing domain and wins whenever it is present. But AWS SES — which
 * is what Resend's inbound runs on, and therefore the ONLY MTA this leg ever reads —
 * stamps its result with `header.i` (the AUID) and emits no `header.d` at all. The i=
 * value is `[local]@domain`, and RFC 6376 requires that domain to be d= or a subdomain
 * of it, so its domain part is a sound stand-in for the signing domain WHEN d is absent.
 * Reading only d left every genuine SES-stamped pass domainless, hence unaligned, hence
 * refused: the leg was inert against its own MTA (observed live 2026-08-14). The fallback
 * fires only when d is missing, so a message carrying both is still judged on d.
 */
function dkimSigningDomain(clause: string): string | null {
  const d = /header\.d\s*=\s*([^\s;]+)/i.exec(clause);
  if (d?.[1]) return d[1].toLowerCase();

  const i = /header\.i\s*=\s*([^\s;]+)/i.exec(clause);
  const auid = i?.[1];
  if (auid) {
    const at = auid.lastIndexOf('@');
    if (at !== -1 && at < auid.length - 1) return auid.slice(at + 1).toLowerCase();
  }
  return null;
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

  const dkim: DkimSignatureResult[] = [];
  let spf: AuthVerdict | null = null;
  let dmarc: AuthVerdict | null = null;

  for (const clause of rest) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    const method = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(trimmed);
    if (!method) continue;

    const verdict = asVerdict(method[2]);
    switch (method[1]?.toLowerCase()) {
      // SPF and DMARC are evaluated once per message, so the FIRST verdict wins and a
      // later clause cannot overwrite it.
      case 'spf':
        spf ??= verdict;
        break;
      // DKIM is evaluated once per SIGNATURE, so every clause is its own result and each
      // keeps the domain it belongs to.
      case 'dkim': {
        if (verdict === null) break;
        dkim.push({ verdict, domain: dkimSigningDomain(trimmed) });
        break;
      }
      case 'dmarc':
        dmarc ??= verdict;
        break;
    }
  }

  return { authservId, spf, dmarc, dkim };
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

/**
 * Our own MTA's verdict, out of however many copies the message carries.
 *
 * EXACTLY ONE, or none at all. Our MTA stamps a single verdict, so a second copy
 * claiming the same authserv-id is not a hop — it is the sender having written one. We
 * cannot tell the two apart by content (that is the whole point of the forgery), so
 * ambiguity resolves to no verdict rather than to a coin flip on ordering.
 *
 * This matters because the provider hands headers back as a MAP, and a map collapses
 * duplicates: when it joins them instead, both land in one value, and picking "the first"
 * would silently depend on whether the receiving MTA prepends or appends.
 */
/**
 * The individual Authentication-Results values out of one header entry.
 *
 * A message with several of the same header — which a FORWARDED message always is, since
 * the forwarder's MTA already stamped one before ours did — comes back from Resend not as
 * repeated keys and not newline-joined, but as a single value that is a JSON-array-ENCODED
 * STRING: `["<ours>","<theirs>"]` (observed live 2026-08-14). Splitting that on newlines
 * finds none, so the whole blob parses as one clause and the authserv-id reads as
 * `["amazonses.com` — every forwarded email refused. Decode the array when the value is
 * one; a real authserv-id is a hostname and never begins with `[`, so the gate is exact.
 */
function headerValues(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch {
      // Not valid JSON after all — fall through and treat it as one ordinary value.
    }
  }
  // Unfolding happens per-candidate inside the parser, so the split is on newlines that
  // are NOT continuations.
  return raw.split(/\r?\n(?![ \t])/);
}

function parsedResults(headers: Readonly<Record<string, string>>): AuthenticationResults[] {
  const raw = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authentication-results',
  )?.[1];
  if (!raw) return [];

  return headerValues(raw)
    .map(parseAuthenticationResults)
    .filter((parsed): parsed is AuthenticationResults => parsed !== null);
}

function trustedResults(
  candidates: readonly AuthenticationResults[],
  authservId: string,
): AuthenticationResults | null {
  const wanted = authservId.toLowerCase();
  const ours = candidates.filter((parsed) => parsed.authservId.toLowerCase() === wanted);
  return ours.length === 1 ? (ours[0] as AuthenticationResults) : null;
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
  const candidates = parsedResults(input.headers);
  const results = trustedResults(candidates, input.authservId);
  if (!results) {
    return {
      trusted: false,
      reason: 'no_trusted_verdict',
      observedAuthservIds: candidates.map((parsed) => parsed.authservId.toLowerCase()),
    };
  }

  // Only signatures that actually verified may vouch for anything. Filtering FIRST is
  // what keeps a pass and an alignment from being read off two different signatures.
  const passing = results.dkim.filter((signature) => signature.verdict === 'pass');
  if (passing.length === 0) {
    return { trusted: false, reason: 'dkim_failed' };
  }

  const fromDomain = input.fromDomain.toLowerCase();
  const aligned = passing.some(
    (signature) => signature.domain !== null && domainsAlign(signature.domain, fromDomain),
  );
  return aligned
    ? { trusted: true, basis: 'dkim_aligned' }
    : { trusted: false, reason: 'dkim_not_aligned' };
}
