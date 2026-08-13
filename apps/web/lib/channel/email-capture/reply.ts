import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { parseEmailAddress } from '~/lib/channel/email/address';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { EMAIL_ALREADY_TAKEN_REPLY, emailCapturedReply } from '~/lib/channel/router/copy';
import { productionChannels } from '~/lib/channel/adapters/production';
import { sendPendingInvite } from '~/lib/loop/calendar-invite';
import { CALENDAR_EMAIL_ASK_TEMPLATE_KEY } from '~/lib/loop/templates/calendar-invite';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';

/**
 * VIL-249 · M13 — the answer to Hale's one question about email.
 *
 * A family provisioned from a text has no address at all (`users.email` is nullable
 * since VIL-237), so a placement Hale makes for them can never leave Hale. After the
 * first such placement Hale asks, once; this reads the answer.
 *
 * NO MODEL. The address becomes the account's contact address and every future invite
 * goes to it — a paraphrase is not an address, and a model that "helpfully" corrects a
 * typo would send a family's calendar to a stranger. So it is a shape check, and a
 * strict one: the message must BE an address, with at most a couple of words of human
 * around it. Anything longer is a sentence, and a sentence is the coach's.
 *
 * CASL. Capturing here is lawful because the parent is answering Hale's own direct
 * question on a channel they expressly consented to — express consent, given in the
 * same exchange, for exactly the mail it names (the invites). The address lands on
 * `users.email`, which is the app's ONE identity store; consent to send to it stays
 * where it already lives, in `email_opt_outs` (absence of a row = consent), so this
 * mints no second live-state store that could disagree with the first.
 *
 * IT NEVER OVERWRITES. A parent who already has an address on file falls through to
 * the coach: changing the address an account signs in with is not something a text
 * should do silently, and the ask that justifies this path is only ever sent to a
 * family that has none.
 */

export type EmailCaptureOutcome =
  | { status: 'declined_to_claim' }
  | { status: 'captured'; reply: string }
  | { status: 'address_taken'; reply: string };

export interface EmailCaptureInput {
  familyId: string;
  parentUserId: string;
  body: string;
  now: Date;
}

/** What the store did. Each value is a different fact about the account, never a
 * bare boolean the caller has to interpret. */
export type EmailCaptureWrite = 'stored' | 'address_taken' | 'already_has_email';

export interface EmailCaptureDeps {
  /** Did Hale actually ASK this family for an address? Only a delivered ask makes an
   * inbound address an answer rather than a stray line for the coach. */
  wasAsked(database: Database, familyId: string): Promise<boolean>;
  /** Store the address on the parent's account, audited (rule #6). */
  capture(
    database: Database,
    input: { familyId: string; parentUserId: string; address: string },
  ): Promise<EmailCaptureWrite>;
  /** Send the invite the family's most recent standing placement owes this parent.
   * True when one actually went out. */
  sendPendingInvite(
    database: Database,
    input: { familyId: string; parentUserId: string },
  ): Promise<boolean>;
}

/** How many words may keep an address company before the message is a sentence. */
const MAX_SURROUNDING_WORDS = 2;

/**
 * The single address this message IS, or null.
 *
 * "me@x.ca" and "it's me@x.ca" are answers. "email me@x.ca about the swim class" is a
 * request, and "a@x.ca or b@x.ca" is a question Hale must not guess at — both fall
 * through to the coach rather than being half-read here.
 */
export function soleEmailAddress(body: string): string | null {
  // A carrier keyword was already answered upstream (STOP/HELP/START); reading one
  // again here could only disagree with the first answer.
  if (matchKeyword(body)) return null;

  const words = body.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_SURROUNDING_WORDS + 1) return null;

  const parsed = words.map((word) => parseEmailAddress(stripEdgePunctuation(word)));
  const addresses = parsed.filter((entry) => entry !== null);
  if (addresses.length !== 1) return null;
  // A second '@' anywhere means a second address we failed to parse — not a word.
  if (words.filter((word) => word.includes('@')).length !== 1) return null;

  return addresses[0]?.address ?? null;
}

/** Trim the punctuation a phone keyboard wraps an address in ("me@x.ca." / "<me@x.ca>"
 * is already handled by the parser). The '@' and '.' inside an address survive. */
function stripEdgePunctuation(word: string): string {
  return word.replace(/^[("'\s]+|[)"',.;:!?\s]+$/g, '');
}

export async function handleEmailCaptureReply(
  database: Database,
  input: EmailCaptureInput,
  deps: EmailCaptureDeps,
): Promise<EmailCaptureOutcome> {
  const address = soleEmailAddress(input.body);
  if (!address) return { status: 'declined_to_claim' };

  if (!(await deps.wasAsked(database, input.familyId))) return { status: 'declined_to_claim' };

  const written = await deps.capture(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    address,
  });
  if (written === 'already_has_email') return { status: 'declined_to_claim' };
  if (written === 'address_taken') {
    return { status: 'address_taken', reply: EMAIL_ALREADY_TAKEN_REPLY };
  }

  const invited = await deps.sendPendingInvite(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
  });
  return { status: 'captured', reply: emailCapturedReply(invited) };
}

// ── The production wiring ────────────────────────────────────────────────────

/** A delivered ask — the question this handler is the answer to. */
async function askWasDelivered(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.templateKey, CALENDAR_EMAIL_ASK_TEMPLATE_KEY),
        inArray(schema.channelMessages.status, ['sent', 'delivered']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Write the address, or say why not.
 *
 * The UPDATE carries `email IS NULL` in its own WHERE rather than trusting the read
 * above it: two texts arriving together would both pass a read-then-write check, and
 * the loser must lose in Postgres, not in JavaScript. The uniqueness pre-check is the
 * same shape from the other side — `users.email` is UNIQUE, so an address another
 * account holds must come back as a sentence Hale can say, not a 23505.
 */
async function captureParentEmail(
  database: Database,
  input: { familyId: string; parentUserId: string; address: string },
): Promise<EmailCaptureWrite> {
  const [holder] = await database
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${input.address}`)
    .limit(1);
  if (holder && holder.id !== input.parentUserId) return 'address_taken';
  if (holder) return 'already_has_email';

  const updated = await database
    .update(schema.users)
    .set({ email: input.address, updatedAt: new Date() })
    .where(and(eq(schema.users.id, input.parentUserId), isNull(schema.users.email)))
    .returning({ id: schema.users.id });
  if (updated.length === 0) return 'already_has_email';

  // Rule #6. The address is the fact being recorded, so it IS the audit row's content.
  // The parent's words are not copied in: the inbound channel_messages row already
  // holds them verbatim, and that row is the CASL evidence this consent rests on.
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'parent_email_captured',
    targetTable: 'users',
    targetId: input.parentUserId,
    after: { source: 'sms_reply', consentBasis: 'answered_hales_direct_ask', address: input.address },
  });
  return 'stored';
}

export function defaultEmailCaptureDeps(): EmailCaptureDeps {
  return {
    wasAsked: askWasDelivered,
    capture: captureParentEmail,
    sendPendingInvite: async (database, input) => {
      const outcome = await sendPendingInvite(database, input, {
        channels: productionChannels(database),
        renderer: loopTemplateRenderer,
      });
      return 'outcome' in outcome && outcome.outcome === 'sent';
    },
  };
}
