import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import { familyHasCoParent, loadPendingAssent } from '~/lib/channel/caregiver/invites';
import { coParentInviteSentAck } from '~/lib/channel/coparent/copy';
import { INTAKE_COPARENT_ASK_TEMPLATE_KEY } from '~/lib/channel/intake/copy';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { normalizePhoneE164 } from '~/lib/channels/phone';
/**
 * A phone number texted after `intake:coparent_ask`.
 *
 * Hale never texts a number first. SMS answers the parent with the redirect and
 * texts nobody. Linq does not collect a number and does not note an identity:
 * the parent starts the iMessage group, and the second real person in that
 * group is the co-parent. A number on iMessage is not this ask, so the turn is
 * left alone.
 */

/** The outbound row of an SMS invite that left before Hale stopped texting numbers. */
export const SMS_COPARENT_INVITE_TEMPLATE_KEY = 'sms:coparent_invite';

/** The parent's ack on the SMS door. The body is {@link coParentInviteSentAck}. */
export const COPARENT_NUMBER_ACK_TEMPLATE_KEY = 'coparent:number_invite_ack';
/** The answer to a number on SMS: nobody was texted. The body is an existing locked line. */
export const COPARENT_NUMBER_HELD_TEMPLATE_KEY = 'coparent:number_invite_held';
/**
 * The Linq parent's instructions. Not an invite ack: nobody was texted.
 */
export const LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY = 'linq:coparent_group_instructions';

const NAME_THEN_PHONE =
  /^(?<name>[\p{L}\p{M}'’.\-]+(?:\s+[\p{L}\p{M}'’.\-]+){0,2})\s+(?<phone>\+?[\d\s().\-]{10,22})$/u;

/**
 * A number, or a name and then a number, and nothing else.
 *
 * "9059629821" and "Sam 905-962-9821" are the ask's answer. A sentence that
 * merely contains a number is not: the school line in the middle of a question
 * must still reach the coach.
 */
export function parseCoParentNumberReply(
  body: string,
): { phoneE164: string; name: string | null } | null {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  const bare = normalizePhoneE164(trimmed);
  if (bare) return { phoneE164: bare, name: null };
  const match = NAME_THEN_PHONE.exec(trimmed);
  const phone = match?.groups?.phone ? normalizePhoneE164(match.groups.phone) : null;
  const name = match?.groups?.name?.replace(/\s+/g, ' ').trim() ?? '';
  if (!phone || name.length === 0 || name.length > 40) return null;
  return { phoneE164: phone, name };
}

/** Slot fill for the locked sent-ack when the parent did not name them. */
function inviteeLabel(name: string | null, language: ReplyLanguage): string {
  if (name) return name;
  return language === 'fr' ? 'cette personne' : 'them';
}

export type CoParentNumberOutcome =
  | { status: 'not_pending' }
  | {
      status: 'sent';
      reply: string;
      templateKey: typeof COPARENT_NUMBER_ACK_TEMPLATE_KEY;
    }
  | {
      status: 'instructed';
      reply: string;
      templateKey: typeof LINQ_GROUP_INSTRUCTIONS_TEMPLATE_KEY;
    }
  | {
      status: 'refused';
      reply: string;
      templateKey: typeof COPARENT_NUMBER_HELD_TEMPLATE_KEY;
    };

/**
 * Answer a number reply, or decline the turn.
 *
 * `not_pending` means this message is not the answer to the ask: the handler
 * must not claim it. A number on iMessage is always `not_pending`. On SMS the
 * number is answered with the redirect and nobody is texted.
 */
export async function deliverCoParentNumberInvite(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    now: Date;
    inboundChannelMessageId: string | null;
  },
): Promise<CoParentNumberOutcome> {
  const parsed = parseCoParentNumberReply(input.body);
  if (!parsed) return { status: 'not_pending' };

  const door = await resolveMessagingDoor(database, input.parentUserId);
  // Sloane, 2026-09-25. A number on iMessage is not an invite and not a note.
  // The co-parent ask already told them how to start the group.
  if (door.channel === 'imessage') return { status: 'not_pending' };

  const language = replyLanguage(input.body);
  const label = inviteeLabel(parsed.name, language);
  if (await familyHasCoParent(database, input.familyId)) return { status: 'not_pending' };
  if (!(await askWasDelivered(database, input))) return { status: 'not_pending' };

  // A redrive of an SMS invite that already left tells the truth again and
  // does not text the number a second time.
  if (await priorSmsInvite(database, input.familyId)) {
    return {
      status: 'sent',
      reply: coParentInviteSentAck(label, language),
      templateKey: COPARENT_NUMBER_ACK_TEMPLATE_KEY,
    };
  }

  // The SMS add-command is waiting on YES. A bare number must not answer past
  // that confirm.
  const pending = await loadPendingAssent(database, input.parentUserId, input.now);
  if (pending?.role === 'co_parent') return { status: 'not_pending' };

  return {
    status: 'refused',
    reply: CO_PARENT_REDIRECT,
    templateKey: COPARENT_NUMBER_HELD_TEMPLATE_KEY,
  };
}

async function askWasDelivered(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<boolean> {
  const rows = await database
    .select({
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      templateKey: schema.channelMessages.templateKey,
      direction: schema.channelMessages.direction,
      status: schema.channelMessages.status,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.templateKey, INTAKE_COPARENT_ASK_TEMPLATE_KEY),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    );
  return rows.some(
    (row) =>
      row.familyId === input.familyId &&
      row.parentUserId === input.parentUserId &&
      row.templateKey === INTAKE_COPARENT_ASK_TEMPLATE_KEY &&
      row.direction === 'out' &&
      (SENT_STATUSES as readonly string[]).includes(row.status),
  );
}

async function priorSmsInvite(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({
      familyId: schema.channelMessages.familyId,
      templateKey: schema.channelMessages.templateKey,
      direction: schema.channelMessages.direction,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.templateKey, SMS_COPARENT_INVITE_TEMPLATE_KEY),
      ),
    );
  return rows.some(
    (row) =>
      row.familyId === familyId &&
      row.direction === 'out' &&
      row.templateKey === SMS_COPARENT_INVITE_TEMPLATE_KEY,
  );
}
