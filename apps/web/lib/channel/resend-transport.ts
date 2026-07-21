import { Resend } from 'resend';

/**
 * The one Resend client for the whole app (VIL-213 · A2). Every email sender —
 * digest, welcome, verification, founder signal — used to `new Resend()` on its
 * own; this is the single seam that owns the SDK client so callers never touch it
 * directly. The from-identity, subject, body, footer, and bcc stay the caller's
 * job (they differ per email) — the transport only performs the raw send and
 * normalizes the provider result.
 *
 * Privacy (rule #1): the error is narrowed to {name, message} on the way out — the
 * raw Resend error can carry the recipient address, and PII must not reach a caller
 * that logs it.
 */
export interface ResendTransport {
  send(msg: {
    from: string;
    to: string;
    subject: string;
    html?: string;
    text: string;
    bcc?: string;
  }): Promise<{ id: string | null; error: { name: string; message: string } | null }>;
}

/** The no-op used when the transport has no way to reach the provider (no api key
 * and no injected client): send() reports "nothing sent, no error", so a caller
 * without credentials degrades to a clean skip instead of constructing a dead
 * client. Callers that need a distinct user-facing skip message keep their own
 * pre-send guard — this is only the transport's own safe default. */
const NOOP_TRANSPORT: ResendTransport = {
  async send() {
    return { id: null, error: null };
  },
};

/** Build the shared transport. Prefers an injected client (tests pass a fake), else
 * constructs `new Resend(apiKey)`, else returns the no-op transport. */
export function createResendTransport(opts?: { apiKey?: string; client?: Resend }): ResendTransport {
  const client = opts?.client ?? (opts?.apiKey ? new Resend(opts.apiKey) : null);
  if (!client) {
    return NOOP_TRANSPORT;
  }
  return {
    async send(msg) {
      const { data, error } = await client.emails.send(msg);
      if (error) {
        return { id: null, error: { name: error.name, message: error.message } };
      }
      return { id: data?.id ?? null, error: null };
    },
  };
}
