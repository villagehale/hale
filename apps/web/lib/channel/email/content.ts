import { Resend } from 'resend';

/**
 * Fetching the message itself.
 *
 * The `email.received` webhook is METADATA ONLY — it carries the sender, the subject,
 * the message id and the attachment list, but no body and no headers
 * (resend.com/docs/dashboard/receiving/get-email-content; the provider does this so a
 * large attachment cannot blow a serverless request limit). Everything the leg actually
 * reasons about therefore arrives on a SECOND call, made after the webhook signature has
 * already proved the notification is genuine.
 *
 * That ordering is the point. The fetch costs a provider round-trip and is the only
 * network call the webhook makes, so it must sit behind authentication — otherwise
 * anyone who can POST to the endpoint can make us call our provider in a loop.
 *
 * BEHIND AN INTERFACE, AND REQUIRED (rule #11). The reader is a non-nullable dependency
 * of the router: an email leg that cannot read email has nothing to fall back to, so
 * "no reader" is not a state the router is allowed to be in. What CAN legitimately
 * happen is that a fetch fails, and that is a named outcome rather than an empty body —
 * an empty body would be indistinguishable from a parent sending a blank message, and
 * would be answered as one.
 */

export interface ReceivedEmailContent {
  text: string | null;
  html: string | null;
  /** Header name → value, as the provider returns it. Names are NOT normalized here;
   * every reader matches case-insensitively. */
  headers: Readonly<Record<string, string>>;
}

export type ContentFetch =
  | { status: 'ok'; content: ReceivedEmailContent }
  /** Named, never folded into an empty body: a message we could not read must not be
   * answered as if the parent had sent nothing. */
  | { status: 'failed'; reason: 'not_found' | 'provider_error' };

export interface InboundContentReader {
  fetch(emailId: string): Promise<ContentFetch>;
}

/**
 * The production reader. Takes an injected client so tests never construct one and
 * never reach the network — the same shape `createResendTransport` uses.
 *
 * Privacy (rule #1): a provider error is narrowed to a reason enum before it leaves.
 * The raw error can carry the recipient address and fragments of the message, and this
 * value ends up in a log line.
 */
export function createResendContentReader(opts: {
  apiKey?: string;
  client?: Pick<Resend['emails'], 'receiving'>;
}): InboundContentReader {
  const client = opts.client ?? (opts.apiKey ? new Resend(opts.apiKey).emails : null);
  if (!client) {
    throw new Error('createResendContentReader: neither an api key nor a client was provided');
  }

  return {
    async fetch(emailId) {
      const { data, error } = await client.receiving.get(emailId);
      if (error || !data) {
        return { status: 'failed', reason: error ? 'provider_error' : 'not_found' };
      }
      return {
        status: 'ok',
        content: { text: data.text, html: data.html, headers: data.headers ?? {} },
      };
    },
  };
}

/** A scripted reader for tests: answers with whatever it was built with. */
export class FakeContentReader implements InboundContentReader {
  readonly requested: string[] = [];

  constructor(private readonly answer: ContentFetch) {}

  static ok(content: Partial<ReceivedEmailContent>): FakeContentReader {
    return new FakeContentReader({
      status: 'ok',
      content: { text: null, html: null, headers: {}, ...content },
    });
  }

  static failing(reason: 'not_found' | 'provider_error'): FakeContentReader {
    return new FakeContentReader({ status: 'failed', reason });
  }

  async fetch(emailId: string): Promise<ContentFetch> {
    this.requested.push(emailId);
    return this.answer;
  }
}
