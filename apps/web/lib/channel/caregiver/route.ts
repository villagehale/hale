import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { readAffirmative } from '~/lib/channel/affirmative';
import { acceptCoParentInvite } from '~/lib/channel/coparent/accept';
import {
  CO_PARENT_ANSWER_PROMPT_BY_LANGUAGE,
  CO_PARENT_DECLINE_ACK_BY_LANGUAGE,
  CO_PARENT_SEAT_TAKEN_LATE_BY_LANGUAGE,
  INVITE_EXPIRED_BY_LANGUAGE,
  coParentInviteDroppedAck,
  coParentWelcome,
} from '~/lib/channel/coparent/copy';
import type { ChannelTransport, InboundMessage } from '~/lib/channel/intake/transport';
import { JOIN_ACCEPTED_ACK } from '~/lib/channel/join/copy';
import { looksLikeJoinRequest } from '~/lib/channel/join/parse';
import { type JoinOutcome, handleJoinRequest } from '~/lib/channel/join/route';
import { replyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { liveMemberMayTalk } from '~/lib/channel/linq/group-members';
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import { type FamilyRole, isCaregiverRole, isParentRole } from '~/lib/channel/role-scope';
import { type OpenQuestion, soleOpenKind } from '~/lib/channel/router/open-questions';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import type { AddThemYourselfUnsent, AddThemYourselfVoice } from './add-them-yourself';
import {
  CAREGIVER_ANSWER_PROMPT,
  CAREGIVER_DECLINE_ACK,
  CAREGIVER_WELCOME,
  inviteDroppedAck,
  scopedReply,
} from './copy';
import {
  type CaregiverInvite,
  type CaregiverLaneInvite,
  type CoParentInvite,
  acceptInvite,
  declineInvite,
  loadPendingAssent,
  recordLapsedInviteAnswered,
} from './invites';
import { type AddRole, looksLikeAddCommand, parseAddCaregiver } from './parse';

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
  /** Writes the one reply to an add-by-number. Required (rule #11): with no composer
   * the parent would be met with silence, and an unsent reply is named in the outcome. */
  addThemYourself: AddThemYourselfVoice;
}

/**
 * A late answer, answered. Its own outcome rather than a member of either lane's union
 * (rule #11): nothing was invited, refused or seated, and folding it into
 * `caregiver_prompted` would tell an operator Hale had asked the question again.
 */
export type LapsedInviteOutcome = {
  status: 'invite_expired_answered';
  role: CaregiverInvite['role'];
};

/**
 * The parent asked Hale to add someone by their number. Hale texts nobody first, so
 * nobody was texted: the parent was told to add them to the family group with Hale in
 * it, or to have them text Hale. `reply` names a reply the composer could not write;
 * then nothing went out.
 */
export type AddThemYourselfOutcome = {
  status: 'add_them_yourself';
  role: AddRole | null;
  reply: 'sent' | AddThemYourselfUnsent;
};

export type CaregiverOutcome =
  | { status: 'caregiver_invite_dropped' }
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
  | { status: 'co_parent_invite_dropped' }
  | {
      status: 'co_parent_accepted';
      /** Whether the inviting parent's confirmation actually went out, and why it did
       * not (rule #11 — the absence is typed, never inferred). `no_channel` is a STOP
       * since they asked; `quiet_hours` is the ads-week fix: the ack is a PROACTIVE
       * message to somebody who texted nothing tonight, so at 22:36 local it holds. The
       * seat happens either way, and they find out the way they always could. */
      inviterNotified: boolean;
      inviterHeld: 'no_channel' | 'quiet_hours' | null;
      /** A caregiver invite in flight on the same number, closed by the seating
       * transaction. Null is the ordinary case. */
      supersededInviteId: string | null;
    }
  | { status: 'co_parent_declined' }
  /**
   * They said yes and the household's one seat had been filled in the meantime. Its own
   * outcome rather than a refusal or a decline (rule #11): nobody refused anything, the
   * message HAD already reached a stranger, and the person who answered is owed a
   * sentence saying why the answer bought them nothing.
   */
  | { status: 'co_parent_seat_taken' }
  /** Also the answer to a LOST race for one invite: nobody was seated twice, and the
   * loser is answered with the same one nudge any unreadable reply gets. */
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
    /**
     * Verbatim for an inbound, and NULL for one Hale may not keep (rule #1).
     *
     * The null case is the co-parent invitee before they have accepted: their words are
     * a non-member's, held only because a parent asked us to text their number, and
     * `channel_messages` here is keyed to the INVITING parent's family. What they decided
     * is already durable without the sentence — the invite's terminal state, and, when
     * they accept, the verbatim reply inside their own consent row.
     */
    body: string | null;
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
 * say (inbound-route.ts). That makes this module the last thing that spoke before a
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

/** Everything the INVITING parent's acknowledgment needs, in one read: whether Hale may
 * text them at all, what to call them, and which clock their night runs on. */
interface InviterContact {
  /** Null means no live channel — a STOP since they asked. */
  phoneE164: string | null;
  name: string | null;
  timeZone: string;
}

async function inviterContact(database: Database, userId: string): Promise<InviterContact> {
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  const row = rows.find((r) => r.id === userId);
  return {
    phoneE164: await resolveSendablePhone(database, userId),
    name: row?.name ?? null,
    // The column is NOT NULL with a default in prod; the fallback only ever serves a
    // store that skipped the default.
    timeZone: row?.timezone ?? DEFAULT_TIMEZONE,
  };
}

/** Why the inviter's confirmation is being withheld, or null when it may go. */
function heldReason(inviter: InviterContact, now: Date): 'no_channel' | 'quiet_hours' | null {
  if (inviter.phoneE164 === null) return 'no_channel';
  return inProactiveQuietHours(now, inviter.timeZone) ? 'quiet_hours' : null;
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

/**
 * The answer that arrived after the invitation had already lapsed (VIL-355 follow-up).
 *
 * WHAT IT REPLACES. `loadOpenInviteByPhone` applies the 72h bound on READ: it closes the
 * row as 'expired' and answers null. Downstream of that null the intake machine found no
 * verified channel either and fell through to `greet` — so the stranger Hale had cold-
 * texted once, answering the question Hale asked them, was met with an intake greeting
 * and asked for their children's names. One honest sentence instead.
 *
 * NOTHING CHANGES BUT THE TRAIL. No seat, no reopened clock, no session: the invitation
 * is over, and the parent's own re-issue (`startCoParentInvite`, which blocks on OPEN
 * invites and on refusals — never on an expired row) is the door back in.
 *
 * `reply`, not `replyToParent`: this goes to the third party, and what Hale says to them
 * is not the inviting parent's conversation.
 */
export async function handleLapsedInviteReply(
  database: Database,
  args: { invite: CaregiverInvite; phoneE164: string; inbound: InboundMessage; now: Date },
  deps: CaregiverDeps,
): Promise<LapsedInviteOutcome> {
  const { invite, inbound, now } = args;
  const lane: Lane = invite.role === 'co_parent' ? 'co_parent' : 'caregiver';
  await record(database, {
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    lane,
    direction: 'in',
    providerId: inbound.providerId,
    // The co-parent lane's rule (see the note on `record`): a non-member's words are not
    // this household's to keep. The caregiver lane keeps its own convention.
    body: lane === 'co_parent' ? null : inbound.body,
    now,
  });
  await reply(database, deps, {
    to: args.phoneE164,
    body: INVITE_EXPIRED_BY_LANGUAGE[replyLanguage(inbound.body)],
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    lane,
    now,
  });
  await recordLapsedInviteAnswered(database, invite);
  return { status: 'invite_expired_answered', role: invite.role };
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
 * Their YES is their OWN express consent, given from the number itself — the second half
 * of the double opt-in, and the reason this path does not lean on CASL's referral
 * exemption. Their NO tells the inviting parent NOTHING: the caregiver precedent, because
 * a refusal from a number is that person's business and not the household's. Their STOP
 * never reaches here at all — the keyword branch upstream closes the invite by number
 * before anybody interprets a word of it.
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
  //
  // WITHOUT THE WORDS. The row proves a message arrived and when; the verbatim text of
  // somebody who has consented to nothing, kept indefinitely in another household's
  // ledger, is what a PIPEDA read of "what do you hold about me" would have to hand back
  // — and the decision it carries is already recorded in the invite's own state.
  await record(database, {
    familyId: invite.familyId,
    parentUserId: invite.invitedByUserId,
    lane: 'co_parent',
    direction: 'in',
    providerId: inbound.providerId,
    body: null,
    now,
  });

  const answer = readAffirmative(inbound.body);

  if (answer === 'yes') {
    // Both read BEFORE the transaction, while the inviting parent is still the only
    // channel on this family: what is about to be written is a second one.
    const inviter = await inviterContact(database, invite.invitedByUserId);
    const seated = await acceptCoParentInvite(database, {
      invite,
      verbatimReply: inbound.body,
      now,
    });
    // The LOSER of a race for the same invite — two phones, one forwarded thread, both
    // saying yes. Nobody was seated twice and nobody is answered twice.
    if (seated.outcome === 'lost_race') return { status: 'co_parent_prompted' };
    // The seat went to somebody else while they thought about it. They are told, because
    // Hale asked them a question and they answered it; the inviting parent is not, for
    // the same reason a refusal is not passed on — and because they are the one who
    // seated the other person.
    if (seated.outcome === 'seat_taken') {
      await reply(database, deps, {
        to: args.phoneE164,
        body: CO_PARENT_SEAT_TAKEN_LATE_BY_LANGUAGE[language],
        familyId: invite.familyId,
        parentUserId: invite.invitedByUserId,
        lane: 'co_parent',
        now,
      });
      return { status: 'co_parent_seat_taken' };
    }
    await reply(database, deps, {
      to: args.phoneE164,
      body: coParentWelcome(inviter.name, language),
      familyId: invite.familyId,
      parentUserId: seated.coParentUserId,
      lane: 'co_parent',
      now,
    });

    // The inviter's ack is the one send here to somebody who texted NOTHING this turn — a
    // proactive extra, not a reply — so it keeps the proactive quiet window, exactly as
    // the join link's does. The seat is already done and the partner already answered;
    // only this sentence waits.
    const inviterHeld = heldReason(inviter, now);
    if (inviterHeld === 'quiet_hours') {
      console.warn(
        { familyId: invite.familyId },
        'co-parent invite accepted: the inviter ack is held for quiet hours - they learn in the morning, or from their partner',
      );
    }
    if (inviter.phoneE164 !== null && inviterHeld === null) {
      await replyToParent(database, deps, {
        to: inviter.phoneE164,
        // The join link's own ack, verbatim: the same person arrived, and the inviting
        // parent must not be told two different things about it. English, because the
        // inviter wrote nothing this turn and language.ts is per MESSAGE — there is no
        // message of theirs in front of us to read (the invitee's is not theirs).
        body: JOIN_ACCEPTED_ACK,
        familyId: invite.familyId,
        parentUserId: invite.invitedByUserId,
        lane: 'co_parent',
        now,
      });
    }

    return {
      status: 'co_parent_accepted',
      inviterNotified: inviterHeld === null,
      inviterHeld,
      supersededInviteId: seated.supersededInviteId,
    };
  }

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
): Promise<CaregiverOutcome | CoParentOutcome | JoinOutcome | AddThemYourselfOutcome | null> {
  const { owner, inbound, now } = args;
  const role = await memberRole(database, owner.familyId, owner.userId);

  if (role && isCaregiverRole(role)) {
    if (
      args.inbound.isGroup === true &&
      args.inbound.chatId &&
      (await liveMemberMayTalk(database, owner.familyId, owner.userId, args.inbound.chatId))
    ) {
      return null;
    }
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
      pending.role !== 'co_parent' ||
      (await coParentAssentIsSoleQuestion(database, owner, now, deps));
    if (answer === 'yes' && claimable) {
      // An add Hale asked about before it stopped texting people first. The invite is
      // left to lapse on its own clock; nobody is texted.
      const lane: Lane = pending.role === 'co_parent' ? 'co_parent' : 'caregiver';
      await record(database, {
        familyId: owner.familyId,
        parentUserId: owner.userId,
        lane,
        direction: 'in',
        providerId: inbound.providerId,
        body: inbound.body,
        now,
      });
      return askThemToJoin(
        database,
        { owner, inbound, parentPhoneE164, now, lane },
        { role: pending.role, name: pending.displayName },
        deps,
      );
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

/**
 * The one reply to an add-by-number, written by the model. Hale texts nobody first: the
 * parent adds the person to the family group with Hale in it, or has them text Hale.
 */
async function askThemToJoin(
  database: Database,
  args: {
    owner: { userId: string; familyId: string };
    inbound: InboundMessage;
    parentPhoneE164: string;
    now: Date;
    lane: Lane;
  },
  person: { role: AddRole | null; name: string | null },
  deps: CaregiverDeps,
): Promise<AddThemYourselfOutcome> {
  const composed = await deps.addThemYourself.compose({
    language: replyLanguage(args.inbound.body),
    name: person.name,
    role: person.role,
    channel: args.inbound.transport === 'imessage' ? 'imessage' : 'sms',
  });
  if (composed.status === 'unsent') {
    return { status: 'add_them_yourself', role: person.role, reply: composed.reason };
  }
  await replyToParent(database, deps, {
    to: args.parentPhoneE164,
    body: composed.body,
    familyId: args.owner.familyId,
    parentUserId: args.owner.userId,
    lane: args.lane,
    now: args.now,
  });
  return { status: 'add_them_yourself', role: person.role, reply: 'sent' };
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
): Promise<AddThemYourselfOutcome | null> {
  const { owner, inbound, now } = args;
  if (!looksLikeAddCommand(inbound.body)) return null;
  const role = await memberRole(database, owner.familyId, owner.userId);
  if (!role || !isParentRole(role)) return null;

  const parsed = parseAddCaregiver(inbound.body);
  const lane: Lane = parsed.ok && parsed.role === 'co_parent' ? 'co_parent' : 'caregiver';

  // Ledgered before the reply: the parent's instruction is on the record whether or not
  // a reply could be written.
  await record(database, {
    familyId: owner.familyId,
    parentUserId: owner.userId,
    lane,
    direction: 'in',
    providerId: inbound.providerId,
    body: inbound.body,
    now,
  });

  return askThemToJoin(
    database,
    { ...args, lane },
    { role: parsed.ok ? parsed.role : null, name: parsed.ok ? parsed.name : null },
    deps,
  );
}
