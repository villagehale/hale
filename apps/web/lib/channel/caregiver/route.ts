import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { readAffirmative } from '~/lib/channel/affirmative';
import {
  CO_PARENT_ANSWER_PROMPT_BY_LANGUAGE,
  CO_PARENT_DECLINE_ACK_BY_LANGUAGE,
  CO_PARENT_REFUSAL_COPY,
  REFERRER_UNNAMED_BY_LANGUAGE,
  coParentInviteDroppedAck,
  coParentInviteSentAck,
  inviterNameIsAffordable,
} from '~/lib/channel/coparent/copy';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport, InboundMessage } from '~/lib/channel/intake/transport';
import { looksLikeJoinRequest } from '~/lib/channel/join/parse';
import { type JoinOutcome, handleJoinRequest } from '~/lib/channel/join/route';
import { replyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { type OpenQuestion, soleOpenKind } from '~/lib/channel/router/open-questions';
import { type FamilyRole, isCaregiverRole, isParentRole } from '~/lib/channel/role-scope';
import type { threadProactiveMessage } from '~/lib/channel/thread';
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
  type CaregiverLaneInvite,
  type CoParentInvite,
  type CoParentRefusal,
  acceptInvite,
  declineInvite,
  loadPendingAssent,
  recordCoParentAssent,
  recordParentAssent,
  startCaregiverInvite,
  startCoParentInvite,
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

/**
 * What Hale is still waiting to hear back about from THIS parent (router/
 * open-questions.ts), read at the one moment this module needs it: just before a bare
 * affirmative is claimed for a co-parent invite (VIL-355).
 *
 * A function rather than the reader object, because that is all this lane asks of it and
 * a whole reader here would let some later branch start resolving questions the router
 * owns. Required, never nullable (rule #11): with no way to see the other open questions
 * this module cannot tell an answer from a coincidence, and the failure mode of guessing
 * is an unsolicited text to a stranger.
 */
export type OpenQuestionsForParent = (
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
) => Promise<readonly OpenQuestion[]>;

export interface CaregiverDeps {
  transport: ChannelTransport;
  /** The parent's own coach thread — REQUIRED (rule #11), and used for the parent's
   * side ONLY. See {@link replyToParent} for which sends reach it and why the
   * caregiver's side deliberately does not. */
  threadMessage: typeof threadProactiveMessage;
  openQuestions: OpenQuestionsForParent;
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

/**
 * VIL-355 · the co-parent lane's outcomes, separate from the caregiver's rather than
 * folded into it (rule #11): every one of these names a different thing that did or did
 * not reach a phone, and `caregiver_add_refused` on a co-parent ask would tell an
 * operator the wrong story about which person Hale declined to text.
 */
export type CoParentOutcome =
  | { status: 'co_parent_invite_started' }
  | { status: 'co_parent_invite_sent' }
  | { status: 'co_parent_invite_dropped' }
  /** `dark` is the flag, and it is a refusal like any other: the parent asked and Hale
   * answered with the forwardable link instead. It is NOT silence. */
  | { status: 'co_parent_add_refused'; reason: CoParentRefusal | 'dark' }
  | { status: 'co_parent_declined' }
  | { status: 'co_parent_prompted' };

/**
 * Which lane a message belongs to, which decides its `channel_messages.category` and its
 * audit verb.
 *
 * `co_parent_invite` is its own category (migration 0112) and not `caregiver`: a
 * caregiver row is a DISCLOSURE to somebody outside the household, and filing a
 * co-parent's own messages under it would describe the opposite of what happened in a
 * PIPEDA right-to-access read (rule #1).
 */
type Lane = 'caregiver' | 'co_parent';

const LANE = {
  caregiver: {
    category: 'caregiver',
    inbound: 'caregiver_sms_inbound',
    outbound: 'caregiver_sms_outbound',
  },
  co_parent: {
    category: 'co_parent_invite',
    inbound: 'co_parent_sms_inbound',
    outbound: 'co_parent_sms_outbound',
  },
} as const satisfies Record<Lane, { category: string; inbound: string; outbound: string }>;

/** One channel_messages row + its audit row (rule #6), on its lane's category. */
async function record(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    lane: Lane;
    direction: 'in' | 'out';
    providerId: string;
    body: string;
    now: Date;
  },
): Promise<string> {
  const lane = LANE[input.lane];
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: input.direction,
      category: lane.category,
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
    actionTaken: input.direction === 'in' ? lane.inbound : lane.outbound,
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}

/**
 * Send one message to a THIRD PARTY and ledger it against the parent who authorised it.
 *
 * Deliberately not threaded, and the name is the guard: what Hale says to a caregiver
 * is not the parent's conversation. Putting it in their transcript would disclose an
 * exchange they are not part of, and would make the transcript claim Hale said to the
 * parent something it said to somebody else. The parent's own side goes through
 * {@link replyToParent}.
 */
async function reply(
  database: Database,
  deps: CaregiverDeps,
  input: {
    to: string;
    body: string;
    familyId: string;
    parentUserId: string;
    lane: Lane;
    now: Date;
  },
): Promise<void> {
  const { providerMessageId } = await deps.transport.send({ to: input.to, body: input.body });
  await record(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    lane: input.lane,
    direction: 'out',
    providerId: providerMessageId,
    body: input.body,
    now: input.now,
  });
}

/**
 * Send one message to the PARENT themselves — the same send, plus their thread.
 *
 * A parent who has finished intake has no open session, so every ordinary text they
 * write arrives here first and falls through to C1 the moment this route has nothing to
 * say (twilio/inbound.ts). That makes this module the last thing that spoke before a
 * coach turn, and `scopeConfirm` is an open question — "Reply YES and I'll text them".
 * Unthreaded, the coach reads the answer with nothing above it, which is the state
 * lib/channel/thread.ts exists to end.
 *
 * A separate function rather than a flag on {@link reply}: which of the two a call site
 * wants is decided by WHO is being texted, and making that a parameter is making it a
 * thing five call sites have to remember.
 */
async function replyToParent(
  database: Database,
  deps: CaregiverDeps,
  input: {
    to: string;
    body: string;
    familyId: string;
    parentUserId: string;
    lane: Lane;
    now: Date;
  },
): Promise<void> {
  await reply(database, deps, input);
  await deps.threadMessage(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    body: input.body,
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
 *
 * DISPATCHED BY THE INVITE'S OWN ROLE rather than by anything about the message: the two
 * lanes write different consent rows, seat different scopes and say different words, and
 * the only thing that knows which is the row the parent opened (VIL-355).
 */
export async function handleInviteReply(
  database: Database,
  args: { invite: CaregiverInvite; phoneE164: string; inbound: InboundMessage; now: Date },
  deps: CaregiverDeps,
): Promise<CaregiverOutcome | CoParentOutcome> {
  return args.invite.role === 'co_parent'
    ? handleCoParentInviteReply(database, { ...args, invite: args.invite }, deps)
    : handleCaregiverInviteReply(database, { ...args, invite: args.invite }, deps);
}

async function handleCaregiverInviteReply(
  database: Database,
  args: { invite: CaregiverLaneInvite; phoneE164: string; inbound: InboundMessage; now: Date },
  deps: CaregiverDeps,
): Promise<CaregiverOutcome> {
  const { invite, inbound, now } = args;
  // Pre-acceptance there is no users row for them (nobody who has not consented gets an
  // identity), so the exchange is ledgered against the parent who authorised it.
  await record(database, {
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    lane: 'caregiver',
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
      lane: 'caregiver',
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
      lane: 'caregiver',
      now,
    });
    return { status: 'caregiver_declined' };
  }

  await reply(database, deps, {
    to: args.phoneE164,
    body: CAREGIVER_ANSWER_PROMPT,
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    lane: 'caregiver',
    now,
  });
  return { status: 'caregiver_prompted' };
}

/**
 * The invitee's answer to the one cold text Hale sent them (VIL-355).
 *
 * Their NO tells the inviting parent NOTHING: the caregiver precedent, because a refusal
 * from a number is that person's business and not the household's. Their STOP never
 * reaches here at all — the keyword branch upstream closes the invite by number before
 * anybody interprets a word of it. Anything else gets one plain restatement.
 */
async function handleCoParentInviteReply(
  database: Database,
  args: { invite: CoParentInvite; phoneE164: string; inbound: InboundMessage; now: Date },
  deps: CaregiverDeps,
): Promise<CoParentOutcome> {
  const { invite, inbound, now } = args;
  const language = replyLanguage(inbound.body);
  // Pre-acceptance there is no users row for them, so the exchange is ledgered against
  // the parent who authorised it — and NOT threaded into that parent's coach thread
  // (`reply`, not `replyToParent`): this is not their conversation.
  await record(database, {
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    lane: 'co_parent',
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  const answer = readAffirmative(inbound.body);

  if (answer === 'no') {
    await declineInvite(database, { invite, by: 'caregiver', now });
    await reply(database, deps, {
      to: args.phoneE164,
      body: CO_PARENT_DECLINE_ACK_BY_LANGUAGE[language],
      familyId: invite.familyId,
      parentUserId: invite.invitedByUserId,
      lane: 'co_parent',
      now,
    });
    return { status: 'co_parent_declined' };
  }

  await reply(database, deps, {
    to: args.phoneE164,
    body: CO_PARENT_ANSWER_PROMPT_BY_LANGUAGE[language],
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    lane: 'co_parent',
    now,
  });
  return { status: 'co_parent_prompted' };
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
): Promise<CaregiverOutcome | CoParentOutcome | JoinOutcome | null> {
  const { owner, inbound, now } = args;
  const role = await memberRole(database, owner.familyId, owner.userId);

  if (role && isCaregiverRole(role)) {
    await record(database, {
      familyId: owner.familyId,
      parentUserId: owner.userId,
      lane: 'caregiver',
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
      lane: 'caregiver',
      now,
    });
    return { status: 'caregiver_scoped_reply' };
  }

  const parentPhoneE164 = args.phoneE164;

  // "add my partner" — the ONE add command with no number in it, because the person
  // being added is not somebody Hale may text. It is answered with a link the parent
  // forwards themselves, and only ever to a PARENT: a co_parent seat is the whole family
  // surface, so the ability to hand one out belongs to nobody else in the household.
  if (role && isParentRole(role) && looksLikeJoinRequest(inbound.body)) {
    return handleJoinRequest(database, { owner, phoneE164: parentPhoneE164, inbound, now }, deps);
  }

  const pending = await loadPendingAssent(database, owner.userId, now);
  if (pending) {
    const answer = readAffirmative(inbound.body);
    const claimable =
      pending.role !== 'co_parent' || (await coParentAssentIsSoleQuestion(database, owner, now, deps));
    if (answer === 'yes' && claimable) {
      return pending.role === 'co_parent'
        ? sendCoParentInvite(database, { pending, owner, inbound, parentPhoneE164, now }, deps)
        : sendInvite(database, { pending, owner, inbound, parentPhoneE164, now }, deps);
    }
    if (answer === 'no' && claimable) {
      return pending.role === 'co_parent'
        ? dropCoParentInvite(database, { pending, owner, inbound, parentPhoneE164, now }, deps)
        : dropInvite(database, { pending, owner, inbound, parentPhoneE164, now }, deps);
    }
    // Neither, or claimed by nobody. The invite is left alone to lapse on its own clock
    // rather than nagging — the parent may simply be talking about something else.
  }

  return startFromCommand(database, { owner, inbound, parentPhoneE164, now }, deps);
}

/**
 * Whether a bare affirmative may be read as the answer to the CO-PARENT scope question.
 *
 * `caregiver/route.ts` claimed one straight off the pending assent, and for a caregiver
 * that was tolerable. Here a mis-claimed YES texts a stranger, so the claim waits on
 * `soleOpenKind` exactly as the founder ping's does (router/handlers.ts): with a question
 * of another kind also open, NOBODY claims the word and the invite lapses unanswered —
 * which is the correct failure, and the only one that cannot put a message on a phone
 * nobody meant to reach.
 */
async function coParentAssentIsSoleQuestion(
  database: Database,
  owner: { userId: string; familyId: string },
  now: Date,
  deps: CaregiverDeps,
): Promise<boolean> {
  const questions = await deps.openQuestions(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    now,
  });
  return soleOpenKind(questions, 'co_parent_assent');
}

/**
 * The parent's YES: their authorisation recorded, then the ONE message, then their own
 * acknowledgment. In that order, because each step is the licence for the next.
 */
async function sendCoParentInvite(
  database: Database,
  args: {
    pending: CoParentInvite;
    owner: { userId: string; familyId: string };
    inbound: InboundMessage;
    parentPhoneE164: string;
    now: Date;
  },
  deps: CaregiverDeps,
): Promise<CoParentOutcome> {
  const { pending, owner, inbound, now } = args;
  // The AUTHORISING reply is what the language is read from, here and for the invite it
  // licenses: the person being texted has written nothing yet, so there is nothing else
  // to read (language.ts is per message, never per family).
  const language = replyLanguage(inbound.body);
  const channelMessageId = await record(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane: 'co_parent',
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  const inviterName = await userName(database, owner.userId);
  // Re-asked at the last moment rather than trusted from the start: the name is free text
  // a parent can clear between the ask and the yes, and an anonymous cold text is the one
  // message this feature exists not to send. The invite stays open and lapses on its own
  // clock — nothing here closes a question the parent answered correctly.
  if (!inviterNameIsAffordable(inviterName)) {
    await replyToParent(database, deps, {
      to: args.parentPhoneE164,
      body: REFERRER_UNNAMED_BY_LANGUAGE[language],
      familyId: owner.familyId,
      parentUserId: owner.userId,
      lane: 'co_parent',
      now,
    });
    return { status: 'co_parent_add_refused', reason: 'referrer_unnamed' };
  }

  const body = await recordCoParentAssent(database, {
    invite: pending,
    inviterName,
    language,
    verbatimReply: inbound.body,
    channelMessageId,
    now,
  });

  await reply(database, deps, {
    to: pending.phoneE164,
    body,
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane: 'co_parent',
    now,
  });
  await replyToParent(database, deps, {
    to: args.parentPhoneE164,
    body: coParentInviteSentAck(pending.displayName, language),
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane: 'co_parent',
    now,
  });
  return { status: 'co_parent_invite_sent' };
}

/** The parent's NO, before anybody was contacted. The invite closes; nothing was sent to
 * the number they named and nothing ever will be on this row. */
async function dropCoParentInvite(
  database: Database,
  args: {
    pending: CoParentInvite;
    owner: { userId: string; familyId: string };
    inbound: InboundMessage;
    parentPhoneE164: string;
    now: Date;
  },
  deps: CaregiverDeps,
): Promise<CoParentOutcome> {
  const { pending, owner, inbound, now } = args;
  const language = replyLanguage(inbound.body);
  await record(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane: 'co_parent',
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });
  await declineInvite(database, { invite: pending, by: 'parent', now });
  await replyToParent(database, deps, {
    to: args.parentPhoneE164,
    body: coParentInviteDroppedAck(pending.displayName, language),
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane: 'co_parent',
    now,
  });
  return { status: 'co_parent_invite_dropped' };
}

async function sendInvite(
  database: Database,
  args: {
    pending: CaregiverLaneInvite;
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
    lane: 'caregiver',
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
    lane: 'caregiver',
    now,
  });
  await replyToParent(database, deps, {
    to: args.parentPhoneE164,
    body: inviteSentAck(pending.displayName),
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane: 'caregiver',
    now,
  });
  return { status: 'caregiver_invite_sent' };
}

async function dropInvite(
  database: Database,
  args: {
    pending: CaregiverLaneInvite;
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
    lane: 'caregiver',
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });
  await declineInvite(database, { invite: pending, by: 'parent', now });
  await replyToParent(database, deps, {
    to: args.parentPhoneE164,
    body: inviteDroppedAck(pending.displayName),
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane: 'caregiver',
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
): Promise<CaregiverOutcome | CoParentOutcome | null> {
  const { owner, inbound, now } = args;
  if (!looksLikeAddCommand(inbound.body)) return null;

  // Read before the ledger row so the row lands in the right LANE. Parsing acts on
  // nothing and sends nothing; what must not happen before the row exists is a decision,
  // and the first of those is still below.
  const parsed = parseAddCaregiver(inbound.body);
  const lane: Lane = parsed.ok && parsed.role === 'co_parent' ? 'co_parent' : 'caregiver';

  // Ledgered before anything acts on it: the parent's instruction is the first link in
  // the chain that ends with a stranger being texted, so it is recorded whether or not
  // we end up able to read it.
  await record(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane,
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  const answer = async <O>(body: string, outcome: O): Promise<O> => {
    await replyToParent(database, deps, {
      to: args.parentPhoneE164,
      body,
      familyId: owner.familyId,
      parentUserId: owner.userId,
      lane,
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

  if (parsed.role === 'co_parent') {
    // DARK BY DEFAULT (D21). The refusal that VIL-355 reverses is kept as the flag-off
    // answer rather than deleted: without it an un-armed family's "add Sam 647… as my
    // partner" falls through to ADD_EXAMPLE, which offers them grandparent, nanny or
    // babysitter — a worse answer than the boundary it replaced. It goes at the flip.
    if (!f14EnabledFor(owner.familyId)) {
      return answer(CO_PARENT_REDIRECT, { status: 'co_parent_add_refused', reason: 'dark' });
    }
    const language = replyLanguage(inbound.body);
    const opened = await startCoParentInvite(database, {
      familyId: owner.familyId,
      invitedByUserId: owner.userId,
      inviterPhoneE164: args.parentPhoneE164,
      inviterName: await userName(database, owner.userId),
      parsed,
      language,
      now,
    });
    return opened.status === 'refused'
      ? answer(CO_PARENT_REFUSAL_COPY[opened.reason][language], {
          status: 'co_parent_add_refused',
          reason: opened.reason,
        })
      : answer(opened.reply, { status: 'co_parent_invite_started' });
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
