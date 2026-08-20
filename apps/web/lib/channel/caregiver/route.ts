import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { readAffirmative } from '~/lib/channel/affirmative';
import { acceptedStatus } from '~/lib/channel/ledger';
import { type FamilyRole, isCaregiverRole } from '~/lib/channel/role-scope';
import type { ChannelTransport, InboundMessage } from '~/lib/channel/intake/transport';
import {
  ADD_EXAMPLE,
  ALREADY_INVITED,
  CAREGIVER_ANSWER_PROMPT,
  CAREGIVER_DECLINE_ACK,
  CAREGIVER_WELCOME,
  CO_PARENT_REDIRECT,
  NUMBER_IN_USE,
  OWN_NUMBER,
  TOO_MANY_INVITES,
  inviteDroppedAck,
  inviteSentAck,
  scopedReply,
} from './copy';
import {
  type CaregiverInvite,
  acceptInvite,
  declineInvite,
  loadPendingAssent,
  recordParentAssent,
  startCaregiverInvite,
} from './invites';
import { looksLikeAddCommand, parseAddCaregiver } from './parse';

/**
 * VIL-241 · M6 — where a caregiver-shaped inbound is routed, and the only place a
 * caregiver's text is answered.
 *
 * The intake machine owns the ORDER (normalize → rate limit → duplicate → CASL
 * keywords → stored state); this module owns two branches it hands off to, both of
 * which sit AFTER the keyword guards so STOP stays a legal instruction rather than a
 * message anyone interprets.
 *
 * WHAT A CAREGIVER CAN ASK: nothing. Every inbound from an accepted caregiver that is
 * not STOP/HELP gets one static line pointing them at the parent. There is no model on
 * this path at all — not a small one, not a cheap one. A conversational surface for a
 * third party is a surface that can be talked into answering about a child, and no
 * amount of prompt care makes that safe enough to ship as a side effect of M6.
 *
 * The parent's confirmation is likewise a KEYWORD, not a reading. It authorises
 * disclosing a family's week to someone outside the household, and a probabilistic
 * "that sounded like a yes" is not a basis for that (deliberate deviation from M2's
 * model-read intent, which decides only whether Hale may watch).
 *
 * WHICH keywords is no longer this module's own list (VIL-260). It held nine words while
 * C1's approval grammar held eleven, and every word on one list and not the other was an
 * answer one of the two surfaces silently dropped — "yes please" was unclear here, and
 * an invite the parent had already agreed to was left to lapse. `readAffirmative` is the
 * one table now; the reading it makes is the same exact, whole-string, keyword-only one.
 */

export interface CaregiverDeps {
  transport: ChannelTransport;
}

export type CaregiverOutcome =
  | { status: 'caregiver_invite_started' }
  | { status: 'caregiver_invite_sent' }
  | { status: 'caregiver_invite_dropped' }
  | {
      status: 'caregiver_add_refused';
      reason:
        | 'own_number'
        | 'number_in_use'
        | 'already_invited'
        | 'too_many'
        | 'unsupported_role'
        | 'unparseable';
    }
  | { status: 'caregiver_accepted' }
  | { status: 'caregiver_declined' }
  | { status: 'caregiver_prompted' }
  | { status: 'caregiver_scoped_reply' };

/** One channel_messages row + its audit row (rule #6), on the caregiver category. */
async function record(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
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
      category: 'caregiver',
      providerMessageId: input.providerId,
      status: input.direction === 'in' ? 'delivered' : acceptedStatus('sms'),
      // Verbatim for INBOUND only — the same rule the loop ledger keeps: an outbound
      // is reconstructable from copy.ts, and storing rendered household detail is a
      // liability (rule #1).
      body: input.direction === 'in' ? input.body : null,
      sentAt: input.now,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) {
    throw new Error('caregiver record: channel_messages insert returned no row');
  }
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: input.direction === 'in' ? 'caregiver_sms_inbound' : 'caregiver_sms_outbound',
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}

/** Send one message to a number and ledger it. */
async function reply(
  database: Database,
  deps: CaregiverDeps,
  input: { to: string; body: string; familyId: string; parentUserId: string; now: Date },
): Promise<void> {
  const { providerMessageId } = await deps.transport.send({ to: input.to, body: input.body });
  await record(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    direction: 'out',
    providerId: providerMessageId,
    body: input.body,
    now: input.now,
  });
}

async function memberRole(
  database: Database,
  familyId: string,
  userId: string,
): Promise<FamilyRole | null> {
  const rows = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, userId));
  const row = rows.find((r) => r.userId === userId && r.familyId === familyId);
  return row ? (row.role as FamilyRole) : null;
}

async function userName(database: Database, userId: string): Promise<string | null> {
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.find((r) => r.id === userId)?.name ?? null;
}

/** The name a caregiver is pointed at. The primary parent's, when we have one — the
 * caregiver knows the household by a person, not by a family id. */
async function primaryParentName(database: Database, familyId: string): Promise<string | null> {
  const rows = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const primary = rows.find((r) => r.familyId === familyId && r.role === 'primary_parent');
  return primary ? userName(database, primary.userId) : null;
}

/**
 * An inbound from a number we have texted an invite to. Their yes is their consent,
 * their no closes it, and anything else gets one plain restatement of the choice.
 */
export async function handleCaregiverInviteReply(
  database: Database,
  args: { invite: CaregiverInvite; phoneE164: string; inbound: InboundMessage; now: Date },
  deps: CaregiverDeps,
): Promise<CaregiverOutcome> {
  const { invite, inbound, now } = args;
  // Pre-acceptance there is no users row for them (nobody who has not consented gets an
  // identity), so the exchange is ledgered against the parent who authorised it.
  await record(database, {
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  const answer = readAffirmative(inbound.body);

  if (answer === 'yes') {
    const { caregiverUserId } = await acceptInvite(database, {
      invite,
      verbatimReply: inbound.body,
      now,
    });
    await reply(database, deps, {
      to: args.phoneE164,
      body: CAREGIVER_WELCOME,
      familyId: invite.familyId,
      parentUserId: caregiverUserId,
      now,
    });
    return { status: 'caregiver_accepted' };
  }

  if (answer === 'no') {
    await declineInvite(database, { invite, by: 'caregiver', now });
    await reply(database, deps, {
      to: args.phoneE164,
      body: CAREGIVER_DECLINE_ACK,
      familyId: invite.familyId,
      parentUserId: invite.invitedByUserId,
      now,
    });
    return { status: 'caregiver_declined' };
  }

  await reply(database, deps, {
    to: args.phoneE164,
    body: CAREGIVER_ANSWER_PROMPT,
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    now,
  });
  return { status: 'caregiver_prompted' };
}

/**
 * An inbound from a number that already owns a verified channel and has no open intake
 * conversation. Two people can be here: a CAREGIVER (who gets the one static line) or a
 * PARENT (who may be answering an invite confirmation, or starting one).
 *
 * Returns null when the message is none of those — the intake machine's existing
 * silence is the right answer, and inventing a reply would teach a parent that Hale
 * responds to everything.
 */
export async function handleKnownNumberInbound(
  database: Database,
  args: {
    owner: { userId: string; familyId: string };
    phoneE164: string;
    inbound: InboundMessage;
    now: Date;
  },
  deps: CaregiverDeps,
): Promise<CaregiverOutcome | null> {
  const { owner, inbound, now } = args;
  const role = await memberRole(database, owner.familyId, owner.userId);

  if (role && isCaregiverRole(role)) {
    await record(database, {
      familyId: owner.familyId,
      parentUserId: owner.userId,
      direction: 'in',
      providerId: inbound.providerId,
      body: inbound.body,
      now,
    });
    await reply(database, deps, {
      to: args.phoneE164,
      body: scopedReply(await primaryParentName(database, owner.familyId)),
      familyId: owner.familyId,
      parentUserId: owner.userId,
      now,
    });
    return { status: 'caregiver_scoped_reply' };
  }

  const parentPhoneE164 = args.phoneE164;
  const pending = await loadPendingAssent(database, owner.userId, now);
  if (pending) {
    const answer = readAffirmative(inbound.body);
    if (answer === 'yes') {
      return sendInvite(database, { pending, owner, inbound, parentPhoneE164, now }, deps);
    }
    if (answer === 'no') {
      return dropInvite(database, { pending, owner, inbound, parentPhoneE164, now }, deps);
    }
    // Neither. The invite is left alone to lapse on its own clock rather than nagging
    // — the parent may simply be talking about something else.
  }

  return startFromCommand(database, { owner, inbound, parentPhoneE164, now }, deps);
}

async function sendInvite(
  database: Database,
  args: {
    pending: CaregiverInvite;
    owner: { userId: string; familyId: string };
    inbound: InboundMessage;
    parentPhoneE164: string;
    now: Date;
  },
  deps: CaregiverDeps,
): Promise<CaregiverOutcome> {
  const { pending, owner, inbound, now } = args;
  const channelMessageId = await record(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  const body = await recordParentAssent(database, {
    invite: pending,
    inviterName: await userName(database, owner.userId),
    verbatimReply: inbound.body,
    channelMessageId,
    now,
  });

  await reply(database, deps, {
    to: pending.phoneE164,
    body,
    familyId: owner.familyId,
    parentUserId: owner.userId,
    now,
  });
  await reply(database, deps, {
    to: args.parentPhoneE164,
    body: inviteSentAck(pending.displayName),
    familyId: owner.familyId,
    parentUserId: owner.userId,
    now,
  });
  return { status: 'caregiver_invite_sent' };
}

async function dropInvite(
  database: Database,
  args: {
    pending: CaregiverInvite;
    owner: { userId: string; familyId: string };
    inbound: InboundMessage;
    parentPhoneE164: string;
    now: Date;
  },
  deps: CaregiverDeps,
): Promise<CaregiverOutcome> {
  const { pending, owner, inbound, now } = args;
  await record(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });
  await declineInvite(database, { invite: pending, by: 'parent', now });
  await reply(database, deps, {
    to: args.parentPhoneE164,
    body: inviteDroppedAck(pending.displayName),
    familyId: owner.familyId,
    parentUserId: owner.userId,
    now,
  });
  return { status: 'caregiver_invite_dropped' };
}

async function startFromCommand(
  database: Database,
  args: {
    owner: { userId: string; familyId: string };
    inbound: InboundMessage;
    parentPhoneE164: string;
    now: Date;
  },
  deps: CaregiverDeps,
): Promise<CaregiverOutcome | null> {
  const { owner, inbound, now } = args;
  if (!looksLikeAddCommand(inbound.body)) return null;

  // Ledgered before anything acts on it: the parent's instruction is the first link in
  // the chain that ends with a stranger being texted, so it is recorded whether or not
  // we end up able to read it.
  await record(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  const parsed = parseAddCaregiver(inbound.body);
  const answer = async (
    body: string,
    outcome: CaregiverOutcome,
  ): Promise<CaregiverOutcome> => {
    await reply(database, deps, {
      to: args.parentPhoneE164,
      body,
      familyId: owner.familyId,
      parentUserId: owner.userId,
      now,
    });
    return outcome;
  };

  if (!parsed.ok) {
    return parsed.reason === 'unsupported_role'
      ? answer(CO_PARENT_REDIRECT, {
          status: 'caregiver_add_refused',
          reason: 'unsupported_role',
        })
      : answer(ADD_EXAMPLE, { status: 'caregiver_add_refused', reason: 'unparseable' });
  }

  const started = await startCaregiverInvite(database, {
    familyId: owner.familyId,
    invitedByUserId: owner.userId,
    inviterPhoneE164: args.parentPhoneE164,
    parsed,
    now,
  });

  if (started.status === 'own_number') {
    return answer(OWN_NUMBER, { status: 'caregiver_add_refused', reason: 'own_number' });
  }
  if (started.status === 'number_in_use') {
    return answer(NUMBER_IN_USE, { status: 'caregiver_add_refused', reason: 'number_in_use' });
  }
  if (started.status === 'already_invited') {
    return answer(ALREADY_INVITED, {
      status: 'caregiver_add_refused',
      reason: 'already_invited',
    });
  }
  if (started.status === 'too_many') {
    return answer(TOO_MANY_INVITES, { status: 'caregiver_add_refused', reason: 'too_many' });
  }
  return answer(started.reply, { status: 'caregiver_invite_started' });
}
