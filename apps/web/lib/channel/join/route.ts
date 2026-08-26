import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import type { InboundMessage, ChannelTransport } from '~/lib/channel/intake/transport';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { JOIN_ACCEPTED_ACK, joinInviteForward, joinWelcome } from './copy';
import { loadOpenJoinInvite, mintJoinInvite, redeemJoinInvite } from './invites';

/**
 * The two ends of the forwardable co-parent link: where it is minted, and where it is
 * spent.
 *
 * They are one module because they are one loop — the message a parent is handed is the
 * message their partner reads, and the token in it is the only thing connecting them.
 * Splitting the halves would put the copy the partner sees in a file the mint never
 * imports, which is exactly how a link and the promise printed beside it drift apart.
 *
 * NEITHER END TEXTS A STRANGER. The mint replies only to the parent who asked; the
 * redemption replies only to a number that has just texted us. That is what makes the
 * whole feature CASL-clean without a double opt-in: there is no message here that
 * anybody did not originate.
 */

export interface JoinDeps {
  transport: ChannelTransport;
  /** The recipient's own coach thread — REQUIRED (rule #11). Both messages this module
   * sends are ones the next C1 turn has to be able to see it having sent: the mint is
   * an offer the parent may ask about ("did they get it?"), and the welcome is the
   * partner's FIRST sentence from Hale, which their reply will be read against. */
  threadMessage: typeof threadProactiveMessage;
}

/**
 * What the redemption itself decided.
 *
 * `inviterNotified` names an absence rather than hiding one (rule #11): the parent who
 * minted the link may have pressed STOP in the days since, and a revoked channel is a
 * message we may not send. The join still happens — their authorisation was recorded
 * when they asked — but an operator reading this outcome has to be able to tell a
 * delivered confirmation from a skipped one.
 */
export interface JoinAcceptance {
  status: 'join_link_accepted';
  familyId: string;
  inviterNotified: boolean;
}

export type JoinOutcome =
  | { status: 'join_link_minted' }
  /**
   * `supersededSessionId` is the other absence this path has to name: a link can arrive
   * mid-conversation, and the intake session it interrupts is CLOSED in the same turn
   * that seats the co-parent. Null means there was nothing open to close — which is the
   * ordinary case — and an id means a conversation ended without finishing, which
   * nobody should have to infer from a closed_at they went looking for. The intake
   * machine fills it: that row is intake's to close, not this module's.
   */
  | (JoinAcceptance & { supersededSessionId: string | null });

/**
 * One channel_messages row + its audit row (rule #6).
 *
 * The CATEGORY is the lane that wrote the message, and this feature spans two. The
 * inviting parent's side is `caregiver` — the household-invite lane, where the rest of
 * "add somebody to my family" already lives. The joining partner's side is `intake`:
 * their arrival is literally the intake path, diverted a step before it would have
 * minted a household, and intake is the category whose whole point is that loop
 * enforcement (quiet hours, caps, prefs) must not apply to a live conversation somebody
 * just started.
 */
async function record(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    category: 'caregiver' | 'intake';
    direction: 'in' | 'out';
    providerId: string;
    body: string;
    now: Date;
  },
): Promise<string> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: input.direction,
      category: input.category,
      providerMessageId: input.providerId,
      status: input.direction === 'in' ? 'delivered' : acceptedStatus('sms'),
      // Verbatim for INBOUND only, the rule the whole ledger keeps: an outbound is
      // reconstructable from copy.ts, and an outbound here carries a live capability
      // token (rule #1).
      body: input.direction === 'in' ? input.body : null,
      sentAt: input.now,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) {
    throw new Error('join record: channel_messages insert returned no row');
  }
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: input.direction === 'in' ? 'join_sms_inbound' : 'join_sms_outbound',
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}

/** Send one message, ledger it, and put it in the recipient's own thread. Every send on
 * this path goes to somebody whose thread it belongs in — there is no third party here
 * (contrast caregiver/route.ts, where the caregiver's side deliberately is not threaded
 * because it is not the parent's conversation). */
async function sendThreaded(
  database: Database,
  deps: JoinDeps,
  input: {
    to: string;
    body: string;
    familyId: string;
    parentUserId: string;
    category: 'caregiver' | 'intake';
    now: Date;
  },
): Promise<void> {
  const { providerMessageId } = await deps.transport.send({ to: input.to, body: input.body });
  await record(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    category: input.category,
    direction: 'out',
    providerId: providerMessageId,
    body: input.body,
    now: input.now,
  });
  await deps.threadMessage(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    body: input.body,
  });
}

async function userName(database: Database, userId: string): Promise<string | null> {
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.find((r) => r.id === userId)?.name ?? null;
}

/**
 * "add my partner" — a parent asking for their co-parent, with no number to text.
 *
 * The reply is one forwardable message and nothing else happens: no stranger is
 * contacted, no seat exists yet, and the partner's own first text is what creates both.
 */
export async function handleJoinRequest(
  database: Database,
  args: {
    owner: { userId: string; familyId: string };
    phoneE164: string;
    inbound: InboundMessage;
    now: Date;
  },
  deps: JoinDeps,
): Promise<JoinOutcome> {
  const { owner, inbound, now } = args;
  // Ledgered before anything acts on it: this sentence is the authorisation for a
  // co-parent seat, so it is recorded whether or not the rest of the turn succeeds.
  const channelMessageId = await record(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    category: 'caregiver',
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  const { code } = await mintJoinInvite(database, {
    familyId: owner.familyId,
    invitedByUserId: owner.userId,
    verbatimRequest: inbound.body,
    channelMessageId,
    now,
  });

  await sendThreaded(database, deps, {
    to: args.phoneE164,
    body: joinInviteForward(code),
    familyId: owner.familyId,
    parentUserId: owner.userId,
    category: 'caregiver',
    now,
  });
  return { status: 'join_link_minted' };
}

/**
 * A first-ever text carrying a join tag: `Hi (via join-…)`, pre-written by the /text
 * page the forwarded link opens.
 *
 * Returns NULL when the token buys nothing — spent, lapsed, or never ours. That is not
 * an error and must not be answered as one: the caller falls back to the ordinary
 * greeting, so somebody holding a dead forward simply meets Hale like anyone else
 * instead of being told they are too late by a product they have never used.
 */
export async function handleJoinArrival(
  database: Database,
  args: { code: string; phoneE164: string; inbound: InboundMessage; now: Date },
  deps: JoinDeps,
): Promise<JoinAcceptance | null> {
  const { inbound, now } = args;
  const invite = await loadOpenJoinInvite(database, args.code, now);
  if (!invite) return null;

  // Both read BEFORE the transaction, while the inviting parent is still the only
  // channel on this family: what we are about to write is a second one.
  const inviterName = await userName(database, invite.invitedByUserId);
  const inviterPhone = await resolveSendablePhone(database, invite.invitedByUserId);

  const redeemed = await redeemJoinInvite(database, {
    invite,
    phoneE164: args.phoneE164,
    verbatimReply: inbound.body,
    now,
  });
  // Somebody else spent this link between the read above and the burn. That is the
  // single-use rule working, and it is the SAME answer a link spent yesterday gives:
  // null, and the ordinary greeting.
  if (!redeemed) return null;
  const { coParentUserId } = redeemed;

  // Recorded AFTER the seat exists, not before: channel_messages.parent_user_id is a
  // NOT NULL reference to a users row, and until the transaction above commits there is
  // no user for this number to be. (The caregiver flow can ledger its inbound first
  // because it has a parent to attribute it to; a join arrival has nobody yet.)
  await record(database, {
    familyId: invite.familyId,
    parentUserId: coParentUserId,
    category: 'intake',
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  await sendThreaded(database, deps, {
    to: args.phoneE164,
    body: joinWelcome(inviterName),
    familyId: invite.familyId,
    parentUserId: coParentUserId,
    category: 'intake',
    now,
  });

  if (inviterPhone) {
    await sendThreaded(database, deps, {
      to: inviterPhone,
      body: JOIN_ACCEPTED_ACK,
      familyId: invite.familyId,
      parentUserId: invite.invitedByUserId,
      category: 'caregiver',
      now,
    });
  }

  return {
    status: 'join_link_accepted',
    familyId: invite.familyId,
    inviterNotified: inviterPhone !== null,
  };
}
