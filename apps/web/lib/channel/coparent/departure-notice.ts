import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import {
  deliverFamilyOutbound,
  familyOutboundTarget,
  familySpeech,
} from '~/lib/channel/linq/family-outbound';
import { groupDepartureNotice } from '~/lib/channel/linq/group-coparent-copy';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type ProactiveHoldReason,
  type ProactiveSendRequest,
  type ProactiveSendVerdict,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
  holdStatus,
} from '~/lib/channel/outbound-gate';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE } from './copy';

/**
 * VIL-355 follow-up · the parent who STAYED is told, once.
 *
 * `departCoParent` ends every standing access the leaving parent held and writes the
 * whole tally — and told nobody. The person who did not act is the one the change
 * happens TO: their household's second seat is gone, their trail suddenly carries five
 * third-person rows, and the only place any of it was visible was a web page they had no
 * reason to open. That is the gap this closes, and it closes it with one sentence.
 *
 * IT IS A SEPARATE FUNCTION, not a step inside the departure transaction, and that is
 * the design. The departure is a database claim whose whole correctness is that it is
 * all-or-nothing; a transport call inside it would either widen the transaction over a
 * network round trip or roll a completed erasure back because a text failed. So the
 * transaction commits first and this runs after it, idempotently, keyed on the departure
 * it is reporting — a retry re-sends nothing.
 *
 * IT NAMES NOBODY (rule #1). Not the parent who left, and no child at all, so the teen
 * redaction question never arises here. See the copy.
 */

export const DEPARTURE_NOTICE_TEMPLATE_KEY = 'co_parent:departed';

/** One notice per departure. A seat can be vacated exactly once per (family, parent) —
 * the conditional DELETE in `departCoParent` is what makes that true — so this key is
 * the whole idempotency story and no counter is needed above it. */
export function departureNoticeDedupeKey(familyId: string, departedUserId: string): string {
  return `co_parent_departed:${familyId}:${departedUserId}`;
}

/**
 * Every way this can end, named (rule #11). `no_staying_parent` is the household whose
 * primary seat is already gone — nothing to tell, and not the same fact as a refusal.
 */
export type DepartureNoticeOutcome =
  | 'sent'
  | 'dark'
  | 'already_sent'
  | 'no_staying_parent'
  | 'no_send_target'
  | 'send_failed'
  | `gate_refused:${ProactiveHoldReason}`;

export interface DepartureNoticePorts {
  gate(request: ProactiveSendRequest): Promise<ProactiveSendVerdict>;
  resolvePhone(database: Database, parentUserId: string): Promise<string | null>;
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
}

/** The gate and the phone resolver, wired to the real readers. The transport is NOT
 * defaulted here: this module never constructs one, so it stays off the Twilio
 * one-door allowlist and the caller has to hand it the door it is using. */
export function departureNoticeReaders(
  database: Database,
): Pick<DepartureNoticePorts, 'gate' | 'resolvePhone'> {
  return {
    gate: (request) => assertProactiveSendAllowed(request, buildOutboundGatePorts(database)),
    resolvePhone: resolveSendablePhone,
  };
}

/**
 * Who is left to tell: the primary parent's seat.
 *
 * Read rather than passed, because the caller of a departure knows who LEFT and has no
 * business deciding who hears about it. Sorted so a household that somehow holds two
 * primary seats picks the same one on every retry rather than racing the heap.
 */
export async function stayingParent(database: Database, familyId: string): Promise<string | null> {
  const rows = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    );
  const seats = rows
    .filter((r) => r.familyId === familyId && r.role === 'primary_parent')
    .map((r) => r.userId)
    .sort();
  return seats[0] ?? null;
}

/**
 * Which language the sentence goes out in, off the recipient's own `users.locale`.
 *
 * `replyLanguage` cannot serve here: it reads the message in front of it, and the parent
 * being told wrote nothing this turn. The stored locale is the only honest source, and
 * it fails toward English — the house default, and the cheaper error (language.ts).
 */
async function parentLanguage(database: Database, userId: string): Promise<ReplyLanguage> {
  const rows = await database
    .select({ id: schema.users.id, locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.find((row) => row.id === userId)?.locale?.startsWith('fr') ? 'fr' : 'en';
}

export async function tellStayingParent(
  database: Database,
  input: { familyId: string; departedUserId: string; now: Date },
  ports: DepartureNoticePorts,
): Promise<DepartureNoticeOutcome> {
  const { familyId, departedUserId, now } = input;

  // DARK BY DEFAULT (D21), like every other class Hale may send unprompted. This one
  // reaches its recipient through a WEB door — the erasure route — so without the flag
  // its arming predicate is only "somebody in this household holds watch consent", and
  // the day a non-SMS path grants that consent the notice starts leaving for households
  // F14 was never flipped on for. Named rather than silent (rule #11), and nothing is
  // written: a household Hale is not live for has no message to keep a receipt about.
  if (!f14EnabledFor(familyId)) {
    console.info({ familyId }, 'co-parent departure notice: household is dark, nothing sent');
    return 'dark';
  }

  const parentUserId = await stayingParent(database, familyId);
  if (parentUserId === null) return 'no_staying_parent';

  const dedupeKey = departureNoticeDedupeKey(familyId, departedUserId);
  // The cheap guard, before the gate reads four tables. The claim below is the correct
  // one — this only keeps a retry from costing anything.
  if (await dedupeActive(dedupeKey, database)) return 'already_sent';

  const verdict = await ports.gate({ familyId, parentUserId, kind: 'co_parent_departed', now });
  if (!verdict.allowed) {
    // A RECEIPT, and its key stays NULL so a suppression can never block the send it is
    // a record of NOT making. The fact itself is not lost: `co_parent_departed` is in
    // the household's trail either way, and this row is what says Hale chose to be quiet.
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'co_parent_departed',
      templateKey: DEPARTURE_NOTICE_TEMPLATE_KEY,
      dedupeKey: null,
      status: holdStatus(verdict.reason),
    });
    console.warn(
      { familyId, reason: verdict.reason },
      'co-parent departure notice: held by the outbound gate',
    );
    return `gate_refused:${verdict.reason}`;
  }

  const target = await familyOutboundTarget(database, familyId);
  let message: string;
  let language: ReplyLanguage;
  if (target.channel === 'group') {
    const speech = await familySpeech(database, familyId, departedUserId);
    language = speech.language;
    message = groupDepartureNotice(language, speech.name);
  } else {
    language = await parentLanguage(database, parentUserId);
    message = CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE[language];
  }

  // CLAIM FIRST, by the insert rather than by the read above: two erasure requests
  // racing the same departure both pass a read and only one wins the unique index.
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'co_parent_departed',
      templateKey: DEPARTURE_NOTICE_TEMPLATE_KEY,
      dedupeKey,
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return 'already_sent';

  const to = await ports.resolvePhone(database, parentUserId);
  if (to === null) {
    // The gate just said this parent has a live channel, so two readers of the same
    // table disagree. Written onto the claimed row rather than thrown: leaving it queued
    // forever would read as a text in flight.
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'no_send_target' })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error(
      { familyId },
      'co-parent departure notice: the gate allowed a parent with no sendable number',
    );
    return 'no_send_target';
  }

  let providerMessageId: string;
  let carried: 'sms' | 'imessage' = 'sms';
  let chatId: string | null = null;
  try {
    const delivered = await deliverFamilyOutbound(database, {
      familyId,
      body: withOptOut(message, verdict.optOut),
      to,
      legacy: ports.transport,
      shareGroupCap: false,
    });
    if (delivered.status === 'held') {
      await database
        .update(schema.channelMessages)
        .set({ status: 'failed', errorCode: 'group_cap' })
        .where(eq(schema.channelMessages.id, claimed.id));
      return 'send_failed';
    }
    providerMessageId = delivered.providerMessageId;
    carried = delivered.channel === 'imessage' ? 'imessage' : 'sms';
    chatId = delivered.chatId;
  } catch (err) {
    const code = err instanceof TwilioSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error({ familyId, code }, 'co-parent departure notice: the provider refused the text');
    return 'send_failed';
  }

  await database
    .update(schema.channelMessages)
    .set({
      providerMessageId,
      channel: carried,
      providerChatId: chatId,
      status: acceptedStatus(carried),
    })
    .where(eq(schema.channelMessages.id, claimed.id));

  // The COMPOSED sentence, not the wire body — the CASL line belongs on the wire and
  // nowhere else, and the coach re-reads this row next turn (channel/thread.ts).
  await ports.threadMessage(database, { familyId, parentUserId, body: message });

  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'co_parent_departure_notice_sent',
    targetTable: 'channel_messages',
    targetId: claimed.id,
    // Nothing that identifies either parent, on the standing rule this whole lane keeps.
    // The language that was CHOSEN, not one re-derived by comparing the rendered message
    // against the English constant: that comparison answered "is this string identical to
    // the EN copy", so any change to how the body is built — a name, a suffix, a second
    // sentence — would have silently relabelled every row `fr`.
    after: { language },
  });

  return 'sent';
}
