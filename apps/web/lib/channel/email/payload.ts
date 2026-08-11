import { z } from 'zod';

/**
 * The `email.received` webhook body, reduced to the fields the leg acts on.
 *
 * The parse is DEFENSIVE about two different things. One is ordinary malformation. The
 * other is that a single webhook endpoint can be subscribed to several event types, and
 * a delivery or bounce event carries a completely different `data` shape under the same
 * envelope — acting on one of those as though it were an inbound message would push a
 * provider notification into a family's conversation. So the type discriminator is
 * checked first and anything else is dropped, quietly and without an error: it is not a
 * failure, it is a subscription we do not serve here.
 *
 * Fields the leg cannot proceed without (`email_id`, `from`, `message_id`) are required;
 * everything else has an honest default, because dropping a parent's message over an
 * absent subject line would be a worse bug than the one it prevents.
 */

const attachment = z.object({}).passthrough();

const schema = z.object({
  type: z.literal('email.received'),
  created_at: z.string().optional(),
  data: z.object({
    email_id: z.string().min(1),
    created_at: z.string().optional(),
    from: z.string().min(1),
    to: z.array(z.string()).optional(),
    /** The sender's own Message-ID. The idempotency key: a provider retry carries the
     * same one, which is how a duplicate is told from a real second email. */
    message_id: z.string().min(1),
    subject: z.string().optional(),
    attachments: z.array(attachment).optional(),
  }),
});

export interface InboundEmailEvent {
  /** The provider's handle for the stored message — what the content fetch needs. */
  emailId: string;
  /** The raw `From` header value, unparsed: parsing it is address.ts's job. */
  from: string;
  to: readonly string[];
  messageId: string;
  subject: string;
  /** Only the COUNT: the attachments themselves are never fetched by this leg. */
  attachmentCount: number;
  receivedAt: Date;
}

/** A timestamp we can actually order events by, or null. An `Invalid Date` would flow
 * silently into a ledger row and a rate-limit window, so it is rejected here. */
function parseTimestamp(...candidates: Array<string | undefined>): Date | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/**
 * The event, or null when this body is not an inbound message we can act on. Never
 * throws: the caller has already authenticated the request, so a body we cannot read is
 * a provider contract change to be dropped and counted, not an exception to surface.
 */
export function parseInboundEmailEvent(rawBody: string): InboundEmailEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const result = schema.safeParse(json);
  if (!result.success) return null;

  const { data } = result.data;
  const receivedAt = parseTimestamp(data.created_at, result.data.created_at);
  if (!receivedAt) return null;

  return {
    emailId: data.email_id,
    from: data.from,
    to: data.to ?? [],
    messageId: data.message_id,
    subject: data.subject ?? '',
    attachmentCount: data.attachments?.length ?? 0,
    receivedAt,
  };
}
