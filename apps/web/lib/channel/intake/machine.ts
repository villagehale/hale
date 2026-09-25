import { type Database, schema } from '@hale/db';
import type { AnalyticsEvent } from '~/lib/analytics/events';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { readAffirmative } from '~/lib/channel/affirmative';
import {
  declineOpenInviteOnStop,
  loadLapsedInviteByPhone,
  loadOpenInviteByPhone,
} from '~/lib/channel/caregiver/invites';
import {
  type CaregiverOutcome,
  type CoParentOutcome,
  type LapsedInviteOutcome,
  type OpenQuestionsForParent,
  handleInviteReply,
  handleKnownNumberInbound,
  handleLapsedInviteReply,
} from '~/lib/channel/caregiver/route';
import { defaultFounderPingPorts, offerFounderWelcome } from '~/lib/channel/founder/ping';
import type { IdentityAskVoice } from '~/lib/channel/identity/ask-voice';
import { defaultNameCaptureDeps, handleNameCaptureReply } from '~/lib/channel/identity/name-reply';
import { maybeSendParentCallName } from '~/lib/channel/identity/parent-call-name';
import { isJoinCode } from '~/lib/channel/join/code';
import { type JoinOutcome, handleJoinArrival } from '~/lib/channel/join/route';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { linqFromE164 } from '~/lib/channel/linq/config';
import { shareHaleContactCardOnce } from '~/lib/channel/linq/contact-card';
import {
  LINQ_GROUP_LINE_MISSING_TEXT,
  formatLinqLineForParent,
  linqCoParentAsk,
} from '~/lib/channel/linq/group';
import { linkPreviewUrl, sendLinqLinkPreview } from '~/lib/channel/linq/link-preview';
import {
  EMERGENCY_REPLY,
  MENTAL_CRISIS_REPLY,
  SAFETY_REPLY_BY_LANGUAGE,
  namesAMentalCrisis,
  namesAnEmergency,
} from '~/lib/channel/off-domain/copy';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone, revokeSmsChannel } from '~/lib/channels/sms-consent-core';
import { projectCivicCandidates } from '~/lib/civic/project';
import { recordCommitment } from '~/lib/commitments/ledger';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { recordCheckpointTold } from '~/lib/health/told';
import { type DiscoveryTrigger, defaultDiscoveryTrigger } from '~/lib/onboarding/trigger-discovery';
import { optOutGuestRemindersOnStop } from '~/lib/party/store';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { type LatLng, geocodeArea } from '~/lib/village/geocode';
import type { IntakeAnswerComposer } from './answer';
import { findReenrollableChannelOwner, reenrolOnStart } from './channel-state';
import { type ConnectorOfferLabel, sendYearConnectorCards } from './connector-offer';
import {
  AMBIGUOUS_CLARIFY_BY_LANGUAGE,
  ASSENT_ACK_BY_LANGUAGE,
  COLD_START_ASK_BY_LANGUAGE,
  CO_PARENT_ASK_BY_LANGUAGE,
  DECLINE_ACK_BY_LANGUAGE,
  HELP_REPLY_BY_LANGUAGE,
  INTAKE_COPARENT_ASK_TEMPLATE_KEY,
  type IntakeGap,
  REGION_UNAVAILABLE_REPLY_BY_LANGUAGE,
  START_ACK_BY_LANGUAGE,
  STOP_ACK_BY_LANGUAGE,
  UNREADABLE_INTAKE_REPLY_BY_LANGUAGE,
  WATCH_OFFER,
  WATCH_OFFER_ASK,
  detailsBlocked,
  firstInboundWords,
  greeting,
  greetingWithArea,
  isBareFirstHello,
  looksLikeIntakeDetails,
  sourceCodeFromBody,
  venueForCode,
} from './copy';
import { parseCanadianPostal, summarizeChildren } from './derive';
import type { ExtractedChild, IntakeCollected, IntakeExtractor } from './extract';
import { identityChallengeReply } from './identity-challenge';
import type { IntakeAckComposer } from './intake-voice';
import type { ReplyIntent, ReplyIntentReader } from './intent';
import { type IntakeKeyword, type IntakeKeywordMatch, matchKeyword } from './keywords';
import {
  cheerUpIntakeReply,
  isCheerUpAsk,
  isLiveLookupAsk,
  liveLookupFallbackReply,
} from './live-lookup';
import { isOfficialPageAsk, officialPageFallbackReply } from './official-page';
import { type IntakeLocation, type ProvisionChild, provisionFromIntake } from './provision';
import { INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY, type RadarComposer } from './radar';
import { FIRST_FIND_BEAT, FIRST_FIND_DUE_HOURS } from './radar-voice';
import {
  type IntakeLadderStep,
  type IntakeSession,
  type IntakeState,
  type SessionPatch,
  type TranscriptEntry,
  createSession,
  loadOpenSession,
  saveSession,
  transcriptHasOutbound,
} from './session';
import { isQuestionOrNewFind, isSoftLadderAck } from './soft-ack';
import type { ChannelTransport } from './transport';
import { claimIntakeTurn, completeIntakeTurn } from './turn-claim';
import { IMPLIED_WATCH_BASIS, recordWatchConsent } from './watch-consent';
import { yearOpenEmptyMessage } from './year-open';

/**
 * VIL-237 · M2 — the conversational SMS intake state machine.
 *
 * ONE entry point, `handleInboundSms`, and a strict order of operations that the whole
 * design rests on:
 *
 *   1. normalize the number   — a number we can't parse can't be replied to at all
 *   2. read the CASL keyword  — a pure string test, so it costs nothing to do first
 *   3. rate limit             — before any spend, any write, any model call
 *   4. duplicate check        — a carrier retry must be a no-op, not a second reply
 *   5. act on the keyword     — STOP is a legal instruction, never an interpretation
 *   6. the stored state       — read from the row, never inferred from the transcript
 *   7. only then, the model
 *
 * Steps 1–5 are deterministic and cannot be reordered: every one of them exists
 * because doing it AFTER the model call would mean a model deciding something that
 * isn't a model's to decide, or spending money on traffic we should have dropped.
 * The keyword is READ (2) before the limit and ACTED ON (5) after the duplicate check,
 * which is what lets step 3 drop a flood without ever dropping an unsubscribe.
 */

const INTAKE_ROUTE = 'sms-inbound';

export interface IntakeDeps {
  transport: ChannelTransport;
  /**
   * Put an outbound in the parent's own coach thread — REQUIRED (rule #11), for the
   * seam this machine sits on rather than for anything it does itself.
   *
   * Intake answers its own questions right up until it stops. The moment the session
   * closes the NEXT text is a C1 turn, and C1 reads `messages` and only `messages`
   * (`channel_messages` stores `body: null`, rule #1). The last thing intake says is the
   * consent ack carrying the name ask — so without this, the coach picks up a
   * conversation on its second sentence and cannot see the first one.
   *
   * Only reachable AFTER provisioning, and that is structural rather than a skip: see
   * {@link sendAndRecord}.
   */
  threadMessage: typeof threadProactiveMessage;
  /**
   * What Hale is still waiting to hear back about from this parent — handed straight to
   * the caregiver/co-parent lane, the one branch on this machine that reads it (VIL-355:
   * a bare YES may not claim a co-parent invite while another question is open).
   *
   * Required, never nullable (rule #11): the absence of this reader is the absence of the
   * arbitration, and the failure it prevents is an unsolicited text to a stranger.
   */
  openQuestions: OpenQuestionsForParent;
  extractor: IntakeExtractor;
  intentReader: ReplyIntentReader;
  radar: RadarComposer;
  /** Writes the acknowledgment half of the one follow-up. Required, never nullable
   * (rule #11): it owns its own deterministic fallback and always returns a whole
   * message, so "no composer" would be a silently colder intake with nothing logged. */
  ackComposer: IntakeAckComposer;
  /** Answers a question the parent asked INSTEAD of answering intake's (answer.ts).
   * Required, never nullable (rule #11): withholding it would restore the exact bug it
   * closed — an off-script question silently becoming a re-ask — and its own "there was
   * nothing to answer" is a named outcome, so absence has no meaning left to carry. */
  answerComposer: IntakeAnswerComposer;
  /** What to call this parent, after a real radar win (PR #689). Intake's consent
   * tail does not call it: a name ask on the assent acknowledgment is the bot voice
   * this turn exists to stop. The dep stays required so a missing composer is a
   * wiring error, not a silent skip of the later ask. */
  identityAsk: IdentityAskVoice;
  limiter: RateLimiter;
  /** Places this family near the free civic sessions already on file, INLINE — pure DB
   * work over rows the civic sweep wrote days ago, so it is fast enough to run before
   * the first reply is composed and is the difference between a real first radar and
   * "still learning your area". */
  seedCivic?: (
    database: Database,
    familyId: string,
    areaCoarse: string | null,
    center: LatLng | null,
    now: Date,
  ) => Promise<number>;
  /** The COARSE area's centroid (rule #1 — an FSA's middle, never a home), so the
   * FIRST radar is filtered by distance like every later one. Null is a valid
   * answer, not a failure: the projection then falls back to its municipality
   * gate. Injected so no test reaches the network. */
  resolveCenter?: (areaCoarse: string) => Promise<LatLng | null>;
  /** Populates the village in the BACKGROUND (one model call + geocodes — far too slow
   * for an inbound webhook). Its payoff is the 48h nudge, which otherwise sweeps a
   * family whose candidate table is empty. Same trigger the web onboarding path uses. */
  discoveryTrigger?: DiscoveryTrigger;
  /** The funnel's two milestones. Optional because the DEFAULT IS THE REAL EFFECT —
   * `captureServerEvent`, which already names its own absence on a dead PostHog key
   * (rule #11) — so this is a test seam, never a way to withhold the send. */
  capture?: typeof captureServerEvent;
  now?: Date;
}

export type KeywordAck = 'sent' | 'provider_answered' | 'provider_refused';

export type IntakeOutcome =
  | { status: 'greeted' }
  | { status: 'follow_up_asked' }
  /** Something Hale will not invent is still missing after the one follow-up. */
  | { status: 'details_blocked'; missing: IntakeGap[] }
  | { status: 'provisioned'; familyId: string }
  /**
   * One ladder beat. `step` is the job this reply settled. `closed` is the
   * co-parent ask, after which the next text belongs to the coach.
   */
  | { status: 'ladder_advanced'; step: IntakeLadderStep; closed: boolean }
  /** `nameAsked` is whether "What should I call you?" went out as its own text,
   * after the turtle card and before the inbox. Never a tail on the assent line.
   * A French reply skips the English line (PR #689). A parent who already has a
   * name is not asked.
   *
   * `connectorOffer` says what became of the inbox ask: `not_offered` is a decline
   * or a first reply that named nothing, and every other value is
   * {@link sendConnectorOffer}'s own named outcome (rule #11).
   *
   * `coParentAsk` is last, its own text. `sent` means the locked co-parent line
   * went out. `not_offered` is the same gate as the inbox ask. */
  | {
      status: 'watch_recorded';
      intent: ReplyIntent;
      granted: boolean;
      nameAsked: boolean;
      connectorOffer: ConnectorOfferLabel | 'not_offered';
      coParentAsk: 'sent' | 'not_offered';
    }
  | { status: 'clarified' }
  /**
   * The parent asked Hale something instead of answering it, and Hale answered them —
   * then asked its own question again in different words. The step DOES NOT MOVE: no
   * consent is read out of a question, no follow-up budget is spent on one, and the
   * next inbound is handled by the same branch as if this turn had not happened.
   *
   * `source` separates the two very different messages that can go out: `composed` is
   * the answer, `safety` is the fixed 811/911 line with no signup question after it.
   */
  | { status: 'question_answered'; source: 'composed' | 'safety' | 'identity' }
  /**
   * VIL-348 — the three CASL keyword turns, each carrying what became of HALE'S OWN
   * acknowledgment. The ledger work is identical in every case; only the reply differs,
   * so the reply is what the outcome names (rule #11):
   *
   *   `sent`              — Hale answered, as it does whenever it is the only answerer.
   *   `provider_answered` — the provider matched this keyword and replied first, so
   *                         Hale's ack is suppressed and no outbound row is written.
   *                         Two confirmations for one STOP is one too many.
   *   `provider_refused`  — Hale tried and the provider permanently refused to deliver.
   *                         Only reachable on the re-enrolment ack, and it means the
   *                         provider's own opt-out list still holds this number while
   *                         Hale's ledger says enrolled. Named rather than thrown: it is
   *                         a configuration fact about someone else's product, and a
   *                         500 here just earns a webhook retry that fails the same way.
   */
  | { status: 'stopped'; ack: KeywordAck }
  | { status: 'helped'; ack: KeywordAck }
  | { status: 'restarted'; ack: KeywordAck }
  | { status: 'region_unavailable' }
  | { status: 'rate_limited' }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: 'invalid_number' | 'no_open_conversation' }
  // VIL-241 · M6 — the caregiver branches. They share this entry point because a
  // caregiver texts the SAME number a parent does; what differs is who the number
  // belongs to, which is a lookup, not a second inbox.
  | CaregiverOutcome
  // VIL-355 · the co-parent SMS invite's own outcomes. Kept out of CaregiverOutcome for
  // the reason the whole ticket exists: the two lanes text different people about
  // different things, and one bucket would make an operator read the wrong story.
  | CoParentOutcome
  // VIL-355 follow-up · a late answer to an invitation that lapsed. Its own outcome
  // because it is neither lane's: nothing was invited, refused or seated.
  | LapsedInviteOutcome
  // The co-parent join link's two ends. Kept OUT of `ignored` deliberately: that
  // outcome's `no_open_conversation` reason is what hands the turn to C1
  // (twilio/inbound.ts), and a redemption has already been answered.
  | JoinOutcome;

interface Inbound {
  from: string;
  body: string;
  providerId: string;
  receivedAt: Date;
  /** The pipe this text arrived on. Absent is SMS — every caller written before
   * iMessage. An iMessage turn carries `chatId` so the ledger can return to it. */
  transport?: 'sms' | 'whatsapp' | 'imessage';
  chatId?: string;
  /** A Linq group turn. The Name and Photo card is 1:1 only. */
  isGroup?: boolean;
  /** VIL-348 — the provider already answered this keyword itself; see
   * `InboundMessage.providerAnsweredKeyword` (intake/transport.ts) for what that means
   * and what it does NOT suppress. Optional here for the same reason it is optional
   * there: a caller written before the provider could answer a keyword means "it
   * answered nothing", which is exactly what absent resolves to. */
  providerAnsweredKeyword?: IntakeKeyword | null;
}

export async function handleInboundSms(
  database: Database,
  inbound: Inbound,
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const now = deps.now ?? inbound.receivedAt;

  // 1. A number we cannot canonicalize is a number we cannot hash, look up, or text
  // back. Dropping it is the only honest option — there is nobody to answer.
  const phoneE164 = normalizePhoneE164(inbound.from);
  if (!phoneE164) {
    return { status: 'ignored', reason: 'invalid_number' };
  }
  const phoneHash = phoneBlindIndex(phoneE164);

  // 2. Is this a CASL keyword? A pure string test — no I/O, no spend — read BEFORE the
  // limit so step 3 cannot drop one. STOP is a legal instruction, not traffic: a parent
  // who has just texted too fast is exactly the parent about to send it, and throttling
  // it away would leave them subscribed with no record of having asked to leave.
  const match = matchKeyword(inbound.body);

  // 3. Rate limit, keyed by the BLIND INDEX (the raw number never reaches the limiter
  // table). Over the limit we go SILENT rather than replying "slow down": a reply is
  // itself an outbound SMS, so answering a flood would hand an SMS-pumping attacker
  // exactly the amplification they came for. Keywords are the one exemption, and they
  // are still COUNTED — the flood budget is spent either way, only the drop is skipped.
  const decision = await deps.limiter.check(phoneHash, INTAKE_ROUTE, RATE_LIMITS[INTAKE_ROUTE]);
  if (!decision.allowed && !match) {
    return { status: 'rate_limited' };
  }

  const session = await loadOpenSession(database, phoneE164);

  // 4. The carrier retried. The provider id is the same, so this is not a parent
  // texting twice — replying again would double every message in the conversation.
  // This in-row check is the CHEAP layer and only sees a retry of the LAST completed
  // turn; the branches below that intake itself ACTS on each take a durable CLAIM
  // (turn-claim.ts, audit P1-4) covering what this never could — a resend racing a
  // turn still running (lastProviderId is written only at the end), the pre-session
  // greet (no row to remember anything), and an out-of-order redelivery of an older
  // message. The fall-through paths to C1 (ignored/no_open_conversation) deliberately
  // claim NOTHING: that seam has its own 0085 claim, and an intake-side refusal there
  // would swallow the retry that heals a crash before the hand-off row existed.
  if (session && session.lastProviderId === inbound.providerId) {
    return { status: 'duplicate' };
  }

  // 5. The keyword read in step 2, acted on. Deliberately UNCLAIMED: STOP is a legal
  // instruction, its handling is deterministic-fast and idempotent, and a claim here
  // would refuse the resend that re-runs a STOP whose first attempt crashed —
  // trading a rare double courtesy-ack for a CASL instruction that cannot be lost.
  if (match) {
    return handleKeyword(database, { match, phoneE164, inbound, session, now }, deps);
  }

  // 6. A live join code outranks whatever conversation this number is already in.
  //
  // It has to be read HERE rather than inside the greeting, because a session shadows
  // the greeting entirely: a partner who texted "Hello" before they tapped the link —
  // or who tapped a link that had already been spent, since that fallback opens a
  // session too — would hold an open conversation that routes every later message to
  // the intake handlers, and could never redeem. The failure reinforces itself, and
  // what it ends in is a SECOND household for a family that already has one.
  //
  // The link is the newer and far more specific instruction, so it wins, and the
  // conversation it interrupts is closed by the same turn.
  const joinTag = joinTagFromBody(inbound.body);
  if (joinTag) {
    const joined = await joinFromTag(
      database,
      { tag: joinTag, session, phoneE164, inbound, now },
      deps,
    );
    if (joined) return joined;
    // Spent, lapsed, forged, or a number that already has its own channel: nothing was
    // seated, so the turn carries on exactly as if the tag had not been there. A LIVE
    // link onto a filled seat is not one of those — it comes back as `join_seat_taken`
    // and is answered, because the person holding it is the household's real other
    // parent (VIL-355).
  }

  if (!session || session.state === 'stopped') {
    // No conversation is open. A first-ever text starts one; a text after the flow has
    // finished belongs to the loop's inbound-reply seam (A3/C3), not here — answering
    // it with a canned blurb would teach a parent that Hale doesn't listen.
    if (session) {
      return { status: 'ignored', reason: 'no_open_conversation' };
    }

    // VIL-241 · a number we have texted an invite to is answering a QUESTION we asked.
    // Checked before the greeting, or a caregiver's "yes" would be read as a stranger
    // starting an intake and they would be asked for their children's names.
    const invite = await loadOpenInviteByPhone(database, phoneE164, now);
    if (invite?.state === 'awaiting_caregiver_reply') {
      return handleInviteReply(database, { invite, phoneE164, inbound, now }, deps);
    }

    const existing = await resolveVerifiedChannelByPhone(database, phoneE164);
    if (existing) {
      // Either a caregiver (who gets the one scoped line) or a parent adding one. Any
      // other message keeps the old silence.
      const outcome = await handleKnownNumberInbound(
        database,
        { owner: existing, phoneE164, inbound, now },
        deps,
      );
      return outcome ?? { status: 'ignored', reason: 'no_open_conversation' };
    }
    // VIL-355 follow-up · the YES that came on day four. `loadOpenInviteByPhone` above
    // applied the 72h bound on read — it closed the row as 'expired' and answered null —
    // and the fall-through below then greeted the stranger Hale had cold-texted once,
    // asking them for their children's names.
    //
    // It sits HERE, after the channel lookup, so a number that now has an account of its
    // own keeps its own path. And it is gated on the message actually BEING an answer:
    // the same person texting Hale months later to sign up their own family is not
    // answering anything, and must still reach the greeting (`loadLapsedInviteByPhone`
    // bounds the same shadow by time).
    if (!invite && readAffirmative(inbound.body) !== 'unclear') {
      const lapsed = await loadLapsedInviteByPhone(database, phoneE164, now);
      if (lapsed) {
        return claimedTurn(database, inbound, now, () =>
          handleLapsedInviteReply(database, { invite: lapsed, phoneE164, inbound, now }, deps),
        );
      }
    }

    // The pre-session greet is the double-welcome bug's home: no session exists, so
    // nothing remembered the sid at all and a >15s first turn greeted twice.
    return claimedTurn(database, inbound, now, () =>
      greet(database, { phoneE164, inbound, now, joinTag }, deps),
    );
  }

  if (session.state === 'awaiting_watch_reply' || session.state === 'awaiting_clarify') {
    return claimedTurn(database, inbound, now, () =>
      handleWatchReply(database, { session, phoneE164, inbound, now }, deps),
    );
  }

  if (session.state === 'awaiting_ladder') {
    return claimedTurn(database, inbound, now, () =>
      handleLadder(database, { session, phoneE164, inbound, now }, deps),
    );
  }

  // VIL-332: createSession commits before send. A leftover awaiting_details
  // row with no outbound is not details — it is a first-hello that never
  // left. handleDetails would extract / HELP / provision and skip greeting().
  if (session.state === 'awaiting_details' && !transcriptHasOutbound(session.transcript)) {
    return claimedTurn(database, inbound, now, () =>
      deliverFirstHello(database, { session, phoneE164, inbound, now }, deps, session.sourceCode),
    );
  }

  return claimedTurn(database, inbound, now, () =>
    handleDetails(database, { session, phoneE164, inbound, now }, deps),
  );
}

/**
 * Run one intake turn under the P1-4 provider-id claim (turn-claim.ts): the first
 * delivery to claim the sid runs; every later one — including a Twilio resend racing
 * this very turn — is the same named 'duplicate' step 4 has always produced. Wraps
 * ONLY the branches where intake itself acts (greet, the model-bound session turns):
 * keywords stay unclaimed (a STOP resend must always be honoured), token-redeeming
 * turns ride their own consume-once claims, and the C1 fall-through claims nothing so
 * the hand-off's 0085 arbitration and its crash-heal retry stay untouched.
 */
async function claimedTurn(
  database: Database,
  inbound: Inbound,
  now: Date,
  run: () => Promise<IntakeOutcome>,
): Promise<IntakeOutcome> {
  if (!(await claimIntakeTurn(database, inbound.providerId, now))) {
    return { status: 'duplicate' };
  }
  const outcome = await run();
  // Stamped only on a turn that returned: a claim whose completed_at stays NULL is
  // the named crash residue (rule #11), visible to an operator, never a silence.
  await completeIntakeTurn(database, inbound.providerId, now);
  return outcome;
}

/**
 * The join tag on this inbound, or null — the ONE reader of "is somebody carrying a
 * co-parent link". Both callers ask the same question of the same string, and two
 * spellings of it is how the router and the greeting end up disagreeing about which
 * tags are capabilities.
 */
function joinTagFromBody(body: string): string | null {
  const tag = sourceCodeFromBody(body);
  return tag !== null && isJoinCode(tag) ? tag : null;
}

/**
 * Redeem a join tag, or hand the turn back.
 *
 * Null means NOTHING WAS SEATED AND NOTHING WAS SAID — a spent, lapsed or forged token,
 * or a number that is already enrolled — and the caller carries on with the routing it
 * would have done anyway. It is not an error and is never answered as one. `seat_taken`
 * also seats nobody, but it HAS been answered, so it ends the turn.
 */
async function joinFromTag(
  database: Database,
  args: {
    tag: string;
    session: IntakeSession | null;
    phoneE164: string;
    inbound: Inbound;
    now: Date;
  },
  deps: IntakeDeps,
): Promise<IntakeOutcome | null> {
  // A number that already owns an active verified channel cannot be SEATED by a link:
  // one active channel per number is a database constraint
  // (`parent_channels_phone_hash_active_idx`), so redeeming would fail the whole
  // transaction. They keep the known-number path they have always had. A number that
  // pressed STOP has no active channel, so their own text — which is what a forwarded
  // link makes them send — is an origination like any other, exactly as START is.
  if (await resolveVerifiedChannelByPhone(database, args.phoneE164)) return null;

  const joined = await handleJoinArrival(
    database,
    { code: args.tag, phoneE164: args.phoneE164, inbound: args.inbound, now: args.now },
    deps,
  );
  if (!joined) return null;
  // Nobody was seated, so nothing supersedes the conversation this link interrupted:
  // they were told the seat is gone and are free to go on being whoever they were on
  // this number. The token is deliberately unburned, so the tap works if a seat frees.
  if (joined.status === 'join_seat_taken') return joined;

  // The conversation the link interrupted is closed in the same turn that seated them,
  // or it shadows their next text exactly as it shadowed this one. `superseded` rather
  // than `complete`: nothing was assembled here.
  if (args.session) {
    await saveSession(
      database,
      args.session,
      { state: 'superseded', closedAt: args.now, lastProviderId: args.inbound.providerId },
      args.now,
    );
  }
  return { ...joined, supersededSessionId: args.session?.id ?? null };
}

// ── outbound plumbing ────────────────────────────────────────────────────────

interface SendContext {
  session: IntakeSession;
  phoneE164: string;
  now: Date;
  /** The pipe this turn arrived on. Outbound rows and the transcript replay
   * record it, so a later receipt can find the Linq chat. */
  pipe: { channel: 'sms' | 'imessage'; chatId: string | null };
}

function messagingPipe(inbound: Inbound): SendContext['pipe'] {
  if (inbound.transport === 'imessage') {
    return { channel: 'imessage', chatId: inbound.chatId ?? null };
  }
  return { channel: 'sms', chatId: null };
}

function sendContext(args: {
  session: IntakeSession;
  phoneE164: string;
  inbound: Inbound;
  now: Date;
}): SendContext {
  return {
    session: args.session,
    phoneE164: args.phoneE164,
    now: args.now,
    pipe: messagingPipe(args.inbound),
  };
}

/**
 * Send one message and record it. Where the record LANDS depends on whether a family
 * exists yet: channel_messages.family_id and .parent_user_id are NOT NULL, so a
 * pre-provisioning message has no row it could legally occupy. Those live encrypted on
 * the intake session and are replayed into channel_messages at provisioning — so the
 * ledger ends up complete either way, it just cannot be written in real time.
 *
 * THE COACH THREAD rides the SAME branch, and for the same reason: `conversations` is
 * family-scoped, so a number that has only said "hi" has no thread a row could occupy
 * either. That is a structural absence, not a withheld effect — there is nothing to log
 * about it, because before provisioning there is no parent for the message to be to. It
 * also costs the coach nothing: everything from the radar on IS threaded, and those are
 * the only sentences a C1 turn ever picks up from (the handoff is the consent ack).
 *
 * The row id comes back (null before provisioning, exactly as {@link recordInbound}
 * does it) because a message that told a family something durable has to be able to say
 * WHICH row carried it — see the checkpoint marker in {@link provision}.
 */
async function sendAndRecord(
  database: Database,
  ctx: SendContext,
  body: string,
  deps: IntakeDeps,
  transcript: TranscriptEntry[],
  /** Stamped on the ledger row when this message is a QUESTION something later has to
   * recognise the answer to. Intake's messages are otherwise anonymous — the transcript
   * is the record — but a capture handler cannot read a transcript, so the one turn that
   * asks for the parent's name carries a key the name capture can query for. */
  templateKey?: string,
): Promise<{ transcript: TranscriptEntry[]; channelMessageId: string | null }> {
  const { providerMessageId } = await deps.transport.send({ to: ctx.phoneE164, body });
  const entry: TranscriptEntry = {
    direction: 'out',
    body,
    providerId: providerMessageId,
    at: ctx.now.toISOString(),
    channel: ctx.pipe.channel,
    chatId: ctx.pipe.chatId,
  };
  if (ctx.session.familyId && ctx.session.userId) {
    const id = await writeChannelMessage(
      database,
      { familyId: ctx.session.familyId, parentUserId: ctx.session.userId },
      entry,
      ctx.now,
      templateKey,
    );
    // What the parent reads back, and what the coach re-reads next turn. The body as
    // SENT: intake appends no CASL footer, so the wire and the thread are one string.
    await deps.threadMessage(database, {
      familyId: ctx.session.familyId,
      parentUserId: ctx.session.userId,
      body,
    });
    if (ctx.pipe.channel === 'imessage' && ctx.pipe.chatId) {
      const preview = linkPreviewUrl(body);
      if (preview) {
        await sendLinqLinkPreview({
          channel: 'imessage',
          chatId: ctx.pipe.chatId,
          url: preview,
          database,
          familyId: ctx.session.familyId,
          parentUserId: ctx.session.userId,
          now: ctx.now,
        });
      }
    }
    return { transcript, channelMessageId: id };
  }
  return { transcript: [...transcript, entry], channelMessageId: null };
}

/** Record an inbound. Same pre/post-provisioning split as {@link sendAndRecord};
 * returns the channel_messages id when there was one to write (the consent evidence
 * points at it). */
async function recordInbound(
  database: Database,
  ctx: SendContext,
  inbound: Inbound,
  transcript: TranscriptEntry[],
): Promise<{ transcript: TranscriptEntry[]; channelMessageId: string | null }> {
  const entry: TranscriptEntry = {
    direction: 'in',
    body: inbound.body,
    providerId: inbound.providerId,
    at: inbound.receivedAt.toISOString(),
    channel: ctx.pipe.channel,
    chatId: ctx.pipe.chatId,
  };
  if (ctx.session.familyId && ctx.session.userId) {
    const id = await writeChannelMessage(
      database,
      { familyId: ctx.session.familyId, parentUserId: ctx.session.userId },
      entry,
      ctx.now,
    );
    return { transcript, channelMessageId: id };
  }
  return { transcript: [...transcript, entry], channelMessageId: null };
}

/** One channel_messages row + its audit row (rule #6: no message without a trail).
 * Keyed on the OWNER rather than the session: the keyword acks (STOP/START/HELP)
 * can know who a number belongs to without holding an open session. */
async function writeChannelMessage(
  database: Database,
  owner: { familyId: string; parentUserId: string },
  entry: TranscriptEntry,
  now: Date,
  templateKey?: string,
): Promise<string> {
  const { familyId, parentUserId } = owner;
  const channel = entry.channel === 'imessage' ? 'imessage' : 'sms';
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel,
      direction: entry.direction,
      category: 'intake',
      templateKey: templateKey ?? null,
      providerMessageId: entry.providerId,
      providerChatId: channel === 'imessage' ? (entry.chatId ?? null) : null,
      status: entry.direction === 'in' ? 'delivered' : acceptedStatus(channel),
      // Verbatim bodies for INBOUND only — an outbound is reconstructable from the
      // copy module, and storing rendered child data is a liability (rule #1).
      body: entry.direction === 'in' ? entry.body : null,
      sentAt: now,
      // Born marked: the machine consumed this text in this very request. The
      // reconciler re-drives any unmarked inbound row to C1, and an intake turn
      // re-driven is a parent answered twice — minutes later, out of context.
      handedOffAt: entry.direction === 'in' ? now : null,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) {
    throw new Error('writeChannelMessage: channel_messages insert returned no row');
  }
  await database.insert(schema.auditLog).values({
    familyId,
    actor: parentUserId,
    actionTaken: entry.direction === 'in' ? 'sms_intake_inbound' : 'sms_intake_outbound',
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}

/**
 * THE ESCAPE FROM THE SCRIPT — the one shape both wobble seams share.
 *
 * Intake asks a question and then reads the next inbound as an answer to it. Every text
 * that is not one used to become a RE-ASK: a question mid-consent came back `ambiguous`
 * and Hale replied with its own question again (live, 2026-08-12, "Does Sebastian needs
 * eye exam?"). The parent was never answered.
 *
 * So before either seam sends its script reply, the parent's words get one chance to be
 * a question. When they are, the message that goes out is the ANSWER plus Hale's own
 * question again in different words — one text, the thread intact.
 *
 * Null is "there was nothing to answer" — a hedge, a pleasantry, more signup
 * detail — and the caller sends what it always sent. A real rec/camp question
 * that the composer declined or could not use is not null (VIL-326): that empty
 * fallback was the leak. Safety is the reviewed line alone.
 */
async function offScriptReply(
  args: {
    parentWords: string;
    pendingAsk: string;
    children: readonly ExtractedChild[];
    postalCode?: string | null;
  },
  deps: IntakeDeps,
): Promise<{ body: string; source: 'composed' | 'safety' | 'identity' } | null> {
  // Crisis / physical emergency go out ALONE, and before any model. A parent in
  // that moment should be dialling, not answering a signup question. Token matches
  // never reach the composer; a composer that still returns `safety` or
  // `mental_crisis` (a phrasing the tokens missed) is honoured below so a silent
  // fake cannot ask-alone. Physical emergency is Call 911 now. Mental crisis is
  // the 988 line. Neither is the child-health 811 SAFETY_REPLY.
  if (namesAnEmergency(args.parentWords)) {
    return { body: EMERGENCY_REPLY, source: 'safety' };
  }
  if (namesAMentalCrisis(args.parentWords)) {
    return { body: MENTAL_CRISIS_REPLY, source: 'safety' };
  }
  // VIL-333. The locked disclosure is the whole turn: no composed concession,
  // no return to the watch ask, no model.
  const disclosure = identityChallengeReply(args.parentWords);
  if (disclosure) {
    return { body: disclosure, source: 'identity' };
  }
  const outcome = await deps.answerComposer.compose(args);
  if (outcome.status === 'mental_crisis') {
    return { body: MENTAL_CRISIS_REPLY, source: 'safety' };
  }
  if (outcome.status === 'safety') {
    return { body: SAFETY_REPLY_BY_LANGUAGE[replyLanguage(args.parentWords)], source: 'safety' };
  }
  if (outcome.status === 'answered') return { body: outcome.body, source: 'composed' };
  // VIL-326 / VIL-327: unavailable / empty must not fall back to the greet or
  // the pending ask alone when they asked a real question. Safety stays above.
  if (isOfficialPageAsk(args.parentWords)) {
    return { body: officialPageFallbackReply(args.pendingAsk), source: 'composed' };
  }
  if (isLiveLookupAsk(args.parentWords)) {
    return { body: liveLookupFallbackReply(args.pendingAsk), source: 'composed' };
  }
  if (isCheerUpAsk(args.parentWords)) {
    return { body: cheerUpIntakeReply(args.pendingAsk), source: 'composed' };
  }
  return null;
}

/**
 * One end of the F14 funnel, recorded.
 *
 * DISTINCT ID IS THE INTAKE SESSION'S OWN ROW ID — a random uuid minted before this
 * conversation has an account — so `intake_started` and `intake_completed` join into a
 * funnel without a phone number, a name, or a hash of either ever reaching PostHog
 * (hard rule #1). The session is also exactly the right grain: one row per attempt to
 * get in, which is the thing being counted.
 *
 * Never in front of a parent's reply, and never able to break one: it runs after the
 * message has gone out and the state has been saved, and a provider failure is logged
 * rather than thrown into the turn (rule #11 — the absence is named, not silent).
 */
async function reportIntakeStep(
  deps: IntakeDeps,
  event: Extract<AnalyticsEvent, 'intake_started' | 'intake_completed'>,
  sessionId: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  try {
    await (deps.capture ?? captureServerEvent)(event, sessionId, properties);
  } catch (err) {
    console.warn('intake analytics: milestone not recorded', {
      event,
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
}

// ── branches ─────────────────────────────────────────────────────────────────

/**
 * A first-ever text, and the start of a new household.
 *
 * A DEAD JOIN TOKEN LANDS HERE, with the tag dropped. Spent, lapsed and forged all fall
 * through to this branch, and none of them is a fault of the person holding the link:
 * they are met like any other stranger rather than told they are too late by a product
 * they have never used.
 *
 * A LIVE one never reaches it — `handleInboundSms` diverts before `createSession`, and
 * that ordering is the whole of it. A session is the record of a household being
 * ASSEMBLED: it collects ages and a postal code, seeds a radar, feeds the founder ping
 * and the comp-poster promo, and ends by inserting a `families` row. None of that is
 * anything a partner joining an existing family should be put through, and every one of
 * those readers takes `session.sourceCode` — so diverting a step later would mean
 * unpicking each of them instead of never entering the flow.
 */
async function greet(
  database: Database,
  args: { phoneE164: string; inbound: Inbound; now: Date; joinTag: string | null },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  // Whatever the join tag was worth was decided before this branch was reached, so all
  // that is left of it here is a DROP: it is not carried onto the session, because a
  // source code rides on into the consent evidence and the provisioning audit row, and
  // a live-looking capability string has no business in either (rule #1).
  const tag = args.joinTag === null ? sourceCodeFromBody(args.inbound.body) : null;
  return greetNewFamily(database, args, deps, tag);
}

async function greetNewFamily(
  database: Database,
  args: { phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
  sourceCode: string | null,
): Promise<IntakeOutcome> {
  const session = await createSession(database, {
    phoneE164: args.phoneE164,
    state: 'awaiting_details',
    sourceCode,
  });
  // Voice already releases a claim when the opener cannot be sent. Intake did
  // not: createSession committed, send/model threw, and the open row swallowed
  // every Twilio retry as details (VIL-332). Close the unfinished claim so the
  // retry can greet on a new session.
  try {
    return await deliverFirstHello(
      database,
      { session, phoneE164: args.phoneE164, inbound: args.inbound, now: args.now },
      deps,
      sourceCode,
    );
  } catch (err) {
    await saveSession(database, session, { closedAt: args.now }, args.now);
    throw err;
  }
}

async function deliverFirstHello(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
  sourceCode: string | null,
): Promise<IntakeOutcome> {
  const { session } = args;
  const ctx = sendContext(args);

  // Names / ages / postal on the first text are DETAILS, not a question — the
  // existing extractor / handleDetails path, never offScriptReply. A bare hello,
  // including the /text warm prefill, still takes greeting() below. Rec/camp
  // questions still answer + COLD_START_ASK (VIL-322).
  if (!isBareFirstHello(args.inbound.body) && looksLikeIntakeDetails(args.inbound.body)) {
    await reportIntakeStep(deps, 'intake_started', session.id);
    return handleDetails(
      database,
      { session, phoneE164: args.phoneE164, inbound: args.inbound, now: args.now },
      deps,
    );
  }

  const recorded = await recordInbound(database, ctx, args.inbound, session.transcript);
  const venue = venueForCode(sourceCode);
  const language = replyLanguage(args.inbound.body);
  // A first text that is ONLY a postal code ("M4B 2B1", live 2026-08-28) answers half
  // the cold-start ask before it is asked. It reaches no extractor — this branch never
  // runs one — so it is captured here, or it is read for nothing and the one follow-up
  // asks the parent for the postal code they opened with.
  const postal = parseCanadianPostal(firstInboundWords(args.inbound.body));
  // ONE message. A bare hi / empty / QR tag still gets the locked greeting. A first
  // inbound that is a question (the site chips, a rec/camp ask) is answered with the
  // same off-script path turn 2 already had — then Hale's pending ask, in one text.
  // VIL-322: two site intakes dropped because greet() never read the inbound body.
  let body = postal ? greetingWithArea(postal.areaCoarse) : greeting(venue?.name ?? null, language);
  let outcome: IntakeOutcome = { status: 'greeted' };
  if (postal === null && !isBareFirstHello(args.inbound.body)) {
    const offScript = await offScriptReply(
      {
        parentWords: args.inbound.body,
        pendingAsk: COLD_START_ASK_BY_LANGUAGE[language],
        children: [],
        postalCode: null,
      },
      deps,
    );
    if (offScript) {
      body = offScript.body;
      outcome = { status: 'question_answered', source: offScript.source };
    }
  }
  const { transcript } = await sendAndRecord(database, ctx, body, deps, recorded.transcript);

  await saveSession(
    database,
    session,
    {
      state: 'awaiting_details',
      transcript,
      lastProviderId: args.inbound.providerId,
      // So the hourly recovery sweep does not re-decrypt every sitting first-hello.
      firstReplyRecoveredAt: args.now,
      ...(postal
        ? {
            collected: {
              children: [],
              // The FSA when that is all they sent (D2) — the token the extractor is
              // handed back as `already_known` on the next turn, so it has to read the
              // way a parent's own postal code does.
              postalCode: postal.postalCode ?? postal.areaCoarse,
            },
          }
        : {}),
    },
    args.now,
  );
  await reportIntakeStep(deps, 'intake_started', session.id);
  return outcome;
}

async function handleDetails(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { session, inbound, now } = args;
  const ctx = sendContext(args);
  const recorded = await recordInbound(database, ctx, inbound, session.transcript);
  let transcript = recorded.transcript;
  const language = replyLanguage(inbound.body);

  const collected = await deps.extractor.extract({
    message: inbound.body,
    alreadyKnown: session.collected,
  });

  const base: SessionPatch = { collected, lastProviderId: inbound.providerId };

  // Nothing readable came back. Before falling back to the unreadable door, find out
  // whether they asked something — a stranger's second text is as likely to be "who is
  // this?" as it is to be two names and two ages, and the couldn't-read line answers
  // neither of them.
  if (collected.children.length === 0) {
    const offScript = await offScriptReply(
      {
        parentWords: inbound.body,
        // The pending ask is handed to the composer so it can get back to the question in
        // its own words — in French when that is the question the parent was asked.
        pendingAsk: COLD_START_ASK_BY_LANGUAGE[language],
        children: collected.children,
        postalCode: collected.postalCode,
      },
      deps,
    );
    if (offScript) {
      ({ transcript } = await sendAndRecord(database, ctx, offScript.body, deps, transcript));
      // The step does not move: `state` and `followUpCount` are untouched, so the ask
      // is still outstanding and the one follow-up is still unspent.
      await saveSession(database, session, { ...base, transcript }, now);
      return { status: 'question_answered', source: offScript.source };
    }
    ({ transcript } = await sendAndRecord(
      database,
      ctx,
      UNREADABLE_INTAKE_REPLY_BY_LANGUAGE[language],
      deps,
      transcript,
    ));
    await saveSession(database, session, { ...base, transcript }, now);
    return { status: 'helped', ack: 'sent' };
  }

  const location = resolveLocation(collected, session.sourceCode);
  if (location === 'unsupported_region') {
    ({ transcript } = await sendAndRecord(
      database,
      ctx,
      REGION_UNAVAILABLE_REPLY_BY_LANGUAGE[language],
      deps,
      transcript,
    ));
    await saveSession(
      database,
      session,
      { ...base, transcript, state: 'complete', closedAt: now },
      now,
    );
    return { status: 'region_unavailable' };
  }

  // The two things Hale refuses to make up. They share ONE ladder because they are the
  // same kind of blocker: a family cannot be set up on a guess, and a guessed age is
  // worse than a guessed postal code — the date it produces is what every stage,
  // checkpoint and registration band is computed from ever after.
  const children = withKnownAges(collected.children);
  if (children === null || location === null) {
    const missing: IntakeGap[] = [
      ...(children === null ? (['ages'] as const) : []),
      ...(location === null ? (['location'] as const) : []),
    ];
    // Exactly ONE targeted follow-up — asking for everything outstanding, because it is
    // the only ask there will be. After that, Hale states the blocker once and goes
    // quiet: a third ask is nagging, and the session stays open so an answer sent later
    // still completes the setup.
    if (session.followUpCount === 0) {
      // The one turn in intake whose WORDS are the product: the model writes the "I heard
      // you" half, the ask is appended deterministically, and any failure comes back as
      // the template with a named reason (intake-voice.ts).
      const ack = await deps.ackComposer.compose({
        parentWords: inbound.body,
        summary: summarizeChildren(collected.children),
        children: collected.children,
        venue: venueForCode(session.sourceCode)?.name ?? null,
        missing,
      });
      ({ transcript } = await sendAndRecord(database, ctx, ack.body, deps, transcript));
      await saveSession(
        database,
        session,
        { ...base, transcript, state: 'awaiting_follow_up', followUpCount: 1 },
        now,
      );
      return { status: 'follow_up_asked' };
    }
    if (session.followUpCount === 1) {
      ({ transcript } = await sendAndRecord(
        database,
        ctx,
        detailsBlocked(missing),
        deps,
        transcript,
      ));
      await saveSession(database, session, { ...base, transcript, followUpCount: 2 }, now);
      return { status: 'details_blocked', missing };
    }
    await saveSession(database, session, { ...base, transcript }, now);
    return { status: 'details_blocked', missing };
  }

  return provision(database, { session, phoneE164: args.phoneE164, inbound, now }, deps, {
    collected,
    children,
    location,
    transcript,
  });
}

/**
 * The children, every one of whose age we were actually told — or null when any was
 * left out. Null is the whole point: {@link ProvisionChild} has a non-null age, so a
 * child we know only the name of cannot reach provisioning at all, and no branch
 * downstream has to decide what date to invent for them.
 */
function withKnownAges(children: readonly ExtractedChild[]): ProvisionChild[] | null {
  const known: ProvisionChild[] = [];
  for (const child of children) {
    if (child.ageMonths === null || child.agePrecision === null) return null;
    known.push({ name: child.name, ageMonths: child.ageMonths, agePrecision: child.agePrecision });
  }
  return known;
}

/**
 * Where the family is, or why we can't say. Three outcomes, and the distinction
 * matters: a postal code we can't place is a COMPLIANCE refusal (rule #1 — Hale is
 * cleared for Canada only), while no postal code at all is just an unanswered
 * question. Conflating them would either turn a shy parent away or quietly onboard a
 * family Hale isn't cleared to serve.
 */
function resolveLocation(
  collected: IntakeCollected,
  sourceCode: string | null,
): IntakeLocation | null | 'unsupported_region' {
  if (collected.postalCode) {
    return parseCanadianPostal(collected.postalCode) ?? 'unsupported_region';
  }
  const venue = venueForCode(sourceCode);
  if (venue) {
    // The venue's own area — a fact about where the poster hangs, never an address.
    return { postalCode: null, areaCoarse: venue.areaCoarse };
  }
  return null;
}

/**
 * The turtle card is Hale's Linq Name and Photo share, and only that.
 * It leaves when Linq reports the line card active and the share lands.
 * No chat line rides with it. SMS has no Linq card, so this returns silent
 * and the name ask (or the French calendar card) still goes out.
 * A group is not this moment. Linq will not share into a chat with no prior outbound.
 */
async function shareFreshLinqContactCard(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    now: Date;
    inbound: Inbound;
  },
): Promise<'shown' | 'silent'> {
  const pipe = messagingPipe(args.inbound);
  if (pipe.channel === 'imessage' && pipe.chatId && args.inbound.isGroup !== true) {
    const shared = await shareHaleContactCardOnce(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      chatId: pipe.chatId,
      channel: 'imessage',
      isGroup: false,
      onboardComplete: true,
      now: args.now,
    });
    return shared.status === 'shared' ? 'shown' : 'silent';
  }
  return 'silent';
}

/**
 * The beats that used to wait for "cool". Same turn, in order: the year find
 * (already sent, its own bubble), the Linq turtle card when that share lands
 * (no chat line), then the name ask. A card that cannot leave still sends the
 * name ask. French skips the English name and sends the calendar card instead.
 */
async function sendPostYearFindLadder(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    phoneE164: string;
    language: ReplyLanguage;
    now: Date;
    inbound: Inbound;
    send: (body: string, templateKey: string) => Promise<unknown>;
  },
  deps: IntakeDeps,
): Promise<IntakeLadderStep> {
  await shareFreshLinqContactCard(database, {
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    now: args.now,
    inbound: args.inbound,
  });
  if (args.language === 'fr') {
    await sendYearConnectorCards(
      database,
      {
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        phoneE164: args.phoneE164,
        language: args.language,
        now: args.now,
        ridesReply: true,
        only: 'gcal',
      },
      { transport: deps.transport, threadMessage: deps.threadMessage },
    );
    return 'gmail';
  }
  const asked = await askParentCallName(database, {
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    language: args.language,
    send: args.send,
  });
  return asked ? 'name_reply' : 'calendar';
}

async function provision(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
  gathered: {
    collected: IntakeCollected;
    children: ProvisionChild[];
    location: IntakeLocation;
    transcript: TranscriptEntry[];
  },
): Promise<IntakeOutcome> {
  const { session, phoneE164, inbound, now } = args;
  const firstInbound = gathered.transcript.find((e) => e.direction === 'in');

  const language = replyLanguage(inbound.body);
  const { familyId, userId } = await provisionFromIntake(database, {
    phoneE164,
    phoneHash: session.phoneHash,
    children: gathered.children,
    location: gathered.location,
    sourceCode: session.sourceCode,
    firstMessage: firstInbound?.body ?? inbound.body,
    transcript: gathered.transcript,
    now,
    language,
  });

  // From here the session HAS a family, so messages go straight to channel_messages —
  // the transcript it carried has just been replayed there.
  const provisioned: IntakeSession = { ...session, familyId, userId };
  const ctx = sendContext({ session: provisioned, phoneE164, inbound, now });

  await seedFirstRadar(database, { familyId, areaCoarse: gathered.location.areaCoarse, now }, deps);

  const radar = await deps.radar.compose({
    familyId,
    children: gathered.collected.children,
    areaCoarse: gathered.location.areaCoarse,
    language,
  });
  const sent = await sendAndRecord(
    database,
    ctx,
    radar.message,
    deps,
    [],
    // VIL-360 · the D23 anchor. Stamped ONLY when this text carried a weekend pick,
    // because the weekday-care ask says "those are all weekend finds" about it, and a
    // question whose premise Hale cannot check is the defect that rule exists to stop.
    radar.weekendPickOffered ? INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY : undefined,
  );

  // The find is its own bubble. The turtle card, when the share lands, and the next
  // visible ask (the name, or the French calendar card) go out in this same turn.
  // Nothing waits on "cool".
  const ladderNext = await sendPostYearFindLadder(
    database,
    {
      familyId,
      parentUserId: userId,
      phoneE164,
      language,
      now,
      inbound,
      send: (body, templateKey) => sendAndRecord(database, ctx, body, deps, [], templateKey),
    },
    deps,
  );

  // The find is the watch. There is no separate yes. The parent's own kids-and-postal
  // text is the verbatim. Consent is written before the stage flip (watch-consent.ts).
  await recordWatchConsent(
    database,
    {
      familyId,
      userId,
      granted: true,
      verbatimReply: inbound.body,
      interpretation: 'implied by the live find',
      channelMessageId: null,
      question: IMPLIED_WATCH_BASIS,
    },
    now,
  );

  // The radar can be the first surface ever to tell this family about a health
  // checkpoint (VIL-238's third rung), and the 48h nudge is two days behind it. Marked
  // AFTER the send, against the row that carried it, so a compose that never left the
  // building suppresses nothing.
  //
  // The outcome is not branched on because there is nothing this turn can do with it —
  // the message is already with the parent — but it is never silent: a marker that did
  // not land is logged as "this checkpoint may be raised again", which is exactly what
  // a lost one costs (lib/health/told.ts).
  if (radar.checkpointTold) {
    await recordCheckpointTold(database, {
      familyId,
      ref: radar.checkpointTold,
      channelMessageId: sent.channelMessageId,
    });
  }

  // MEM-10 · the forward beat is a promise with a clock on it, and until now the only
  // thing holding it was the hope that the 48h sweep would pick this family up. Written
  // against the row that carried it, for the same reason the told-marker is: a message
  // that never reached a transport put nobody in Hale's debt.
  //
  // Not branched on, for the same reason either: the parent already has the text. A
  // write that did not land is logged as "this debt is invisible", which is exactly what
  // a lost row costs (lib/commitments/ledger.ts).
  if (radar.firstFindPromised) {
    await recordCommitment(database, {
      familyId,
      kind: 'first_find',
      summary:
        radar.message === yearOpenEmptyMessage('en') || radar.message === yearOpenEmptyMessage('fr')
          ? radar.message
          : FIRST_FIND_BEAT,
      dueAt: new Date(now.getTime() + FIRST_FIND_DUE_HOURS * 3_600_000),
      channelMessageId: sent.channelMessageId,
    });
  }

  // A family that walked in from one of the founder's own posters, and the one message in
  // this product a person writes rather than Hale. The ping goes to HIS thread and carries
  // the poster and nothing else (rule #1); the offer it makes is registered on the
  // open-loops ledger in the same flow, so his YES resolves through the same reply-standing
  // primitives every other answer does (lib/channel/founder/ping.ts).
  //
  // Not branched on, for the reason the two writes above are not: this parent already has
  // their radar, and nothing this turn can do about a ping is worth losing them over. Every
  // way it can decline is a named outcome with the cost in the log (rule #11).
  await offerFounderWelcome(
    database,
    { newFamilyId: familyId, sourceCode: session.sourceCode, now },
    defaultFounderPingPorts(deps.transport),
  );

  await saveSession(
    database,
    session,
    {
      collected: gathered.collected,
      transcript: gathered.transcript,
      state: 'awaiting_ladder',
      familyId,
      userId,
      lastProviderId: inbound.providerId,
      findWon: radar.findWon,
      ladderNext,
      ladderLanguage: language,
    },
    now,
  );
  // `source_code` is null when nobody handed out a card, and it stays ABSENT rather than
  // becoming a string like 'direct': buildEvent drops a null, and a bucket meaning "no
  // card" must not be able to look like a card that exists.
  await reportIntakeStep(deps, 'intake_completed', session.id, {
    source_code: session.sourceCode,
  });
  return { status: 'provisioned', familyId };
}

/**
 * Give the first reply something true to say, and the 48h nudge something to find.
 *
 * A family that has existed for four milliseconds has no village candidates and no
 * civic placements, so the radar could only ever answer "still learning your area" —
 * the emptiest possible first impression, on the one message a stranger is guaranteed
 * to read. The web onboarding path already solved half of this (complete-onboarding
 * fires the same discovery trigger); intake never did either half.
 *
 * The split is by COST. The civic projection is pure DB work over rows the sweep wrote
 * days ago, so it runs INLINE and its output is visible to the radar composed one line
 * later. Discovery is a model call plus geocodes, far past a Twilio webhook's budget,
 * so it runs in the background and pays off at the 48h nudge instead.
 *
 * VIL-260 · WS5 adds ONE coarse-area geocode to the inline half, and it does not move
 * that line: `radar.compose` on the very next statement already resolves the same FSA
 * through its weather port, so this is the same lookup on the same input rather than a
 * new class of cost. What it buys is that the FIRST radar a stranger ever reads is
 * distance-filtered like every later one — without it, a Scarborough family's opening
 * message could offer an Etobicoke storytime.
 *
 * Neither may fail the intake: a parent has already been provisioned by this point, and
 * a missing weekend suggestion is not worth losing them over (rule #8 boundary catch).
 */
async function seedFirstRadar(
  database: Database,
  args: { familyId: string; areaCoarse: string | null; now: Date },
  deps: IntakeDeps,
): Promise<void> {
  // Resolved OUTSIDE the projection's try, and degrading to null rather than
  // throwing: a geocoding miss must cost this family proximity, never the whole
  // seeding — an unplaced projection still has its municipality gate.
  const center = await resolveSeedCenter(args.areaCoarse, deps);
  try {
    const seedCivic = deps.seedCivic ?? projectCivicCandidates;
    await seedCivic(database, args.familyId, args.areaCoarse, center, args.now);
  } catch (err) {
    console.error('intake civic projection failed (intake unaffected)', err);
  }
  try {
    const trigger = deps.discoveryTrigger ?? defaultDiscoveryTrigger();
    trigger(args.familyId, database);
  } catch (err) {
    console.error('intake first-village discovery trigger failed (intake unaffected)', err);
  }
}

/** The family's coarse centroid, or null when there is no area or it cannot be
 * placed. Never throws — "we could not place them" is an answer the projection
 * knows how to act on. */
async function resolveSeedCenter(
  areaCoarse: string | null,
  deps: IntakeDeps,
): Promise<LatLng | null> {
  if (areaCoarse === null) return null;
  try {
    return await (deps.resolveCenter ?? geocodeArea)(areaCoarse);
  } catch (err) {
    console.error('intake coarse-area geocode failed (projection falls back to area)', err);
    return null;
  }
}

async function handleWatchReply(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { session, inbound, now } = args;
  const ctx = sendContext(args);
  const recorded = await recordInbound(database, ctx, inbound, session.transcript);
  const language = replyLanguage(inbound.body);

  // The QUESTION stays English because the question that was actually asked was English:
  // WATCH_OFFER rides out appended to the model-composed radar line, which has no
  // language of its own yet (see the note in copy.ts). What the reader is given must be
  // what the parent read.
  const reading = await deps.intentReader.read({ question: WATCH_OFFER, reply: inbound.body });

  // A PARENT WHO ASKED SOMETHING IS NOT A PARENT GIVING A WOBBLY ANSWER, and until this
  // branch existed the two were the same `ambiguous`. Checked before the clarify budget
  // and before the conservative no, because a question must cost neither: asking one is
  // not a refusal to decide, and recording it as a decline would be Hale reading consent
  // out of a sentence that was never about consent (rule #4).
  if (reading.intent === 'ambiguous') {
    const offScript = await offScriptReply(
      {
        parentWords: inbound.body,
        pendingAsk: WATCH_OFFER_ASK,
        children: session.collected.children,
        postalCode: session.collected.postalCode,
      },
      deps,
    );
    if (offScript) {
      await sendAndRecord(database, ctx, offScript.body, deps, recorded.transcript);
      // `state` and `clarifyCount` are untouched: the consent ask is still outstanding
      // and the one clarification is still unspent, so the next inbound lands here again.
      await saveSession(database, session, { lastProviderId: inbound.providerId }, now);
      return { status: 'question_answered', source: offScript.source };
    }
  }

  // One gentle clarification, then Hale decides conservatively. Asking twice about
  // the same yes/no is pestering; guessing "yes" would manufacture consent.
  if (reading.intent === 'ambiguous' && session.clarifyCount === 0) {
    await sendAndRecord(
      database,
      ctx,
      AMBIGUOUS_CLARIFY_BY_LANGUAGE[language],
      deps,
      recorded.transcript,
    );
    await saveSession(
      database,
      session,
      { state: 'awaiting_clarify', clarifyCount: 1, lastProviderId: inbound.providerId },
      now,
    );
    return { status: 'clarified' };
  }

  const granted = reading.intent === 'assent';
  const interpretation =
    reading.intent === 'ambiguous'
      ? `still unclear after one clarification — recorded as no (${reading.interpretation})`
      : reading.interpretation;

  // Consent BEFORE the stage flip, in one transaction (see watch-consent.ts).
  await recordWatchConsent(
    database,
    {
      familyId: session.familyId as string,
      userId: session.userId as string,
      granted,
      verbatimReply: reading.verbatim,
      interpretation,
      channelMessageId: recorded.channelMessageId,
    },
    now,
  );

  const ack = granted
    ? assentAck(language)
    : { body: DECLINE_ACK_BY_LANGUAGE[language], asked: false };
  await sendAndRecord(database, ctx, ack.body, deps, recorded.transcript);

  // A yes that earned the ladder gets the assent only. Turtle waits for the
  // next reply. A decline closes. Neither turn stacks the name, the cards, or
  // the co-parent ask onto the acknowledgment.
  const earned = granted && session.findWon;
  await saveSession(
    database,
    session,
    earned
      ? {
          state: 'awaiting_ladder',
          lastProviderId: inbound.providerId,
          ladderNext: 'turtle',
          ladderLanguage: language,
        }
      : {
          state: 'complete',
          closedAt: now,
          lastProviderId: inbound.providerId,
          ladderNext: null,
        },
    now,
  );
  return {
    status: 'watch_recorded',
    intent: reading.intent,
    granted,
    nameAsked: false,
    connectorOffer: 'not_offered',
    coParentAsk: 'not_offered',
  };
}

/**
 * One inbound, one ladder job. The year find already ended its own turn.
 * A physical emergency or a mental-health crisis is answered and does not
 * spend the beat.
 */
async function handleLadder(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { session, phoneE164, inbound, now } = args;
  const step = session.ladderNext;
  const familyId = session.familyId;
  const userId = session.userId;
  if (!step || !familyId || !userId) {
    console.error(
      { sessionId: session.id, state: session.state, step, hasFamily: Boolean(familyId) },
      'intake ladder: open session has no next step',
    );
    await saveSession(
      database,
      session,
      { state: 'complete', closedAt: now, lastProviderId: inbound.providerId, ladderNext: null },
      now,
    );
    return { status: 'ignored', reason: 'no_open_conversation' };
  }

  const language = session.ladderLanguage ?? replyLanguage(inbound.body);
  const ctx = sendContext(args);
  const recorded = await recordInbound(database, ctx, inbound, session.transcript);

  if (namesAnEmergency(inbound.body) || namesAMentalCrisis(inbound.body)) {
    const crisis = namesAnEmergency(inbound.body) ? EMERGENCY_REPLY : MENTAL_CRISIS_REPLY;
    await sendAndRecord(database, ctx, crisis, deps, recorded.transcript);
    await saveSession(database, session, { lastProviderId: inbound.providerId }, now);
    return { status: 'question_answered', source: 'safety' };
  }

  let next: IntakeLadderStep | null = step;
  let closed = false;
  let heldForQuestion = false;

  if ((step === 'turtle' || step === 'name_reply') && isQuestionOrNewFind(inbound.body)) {
    const offScript = await offScriptReply(
      {
        parentWords: inbound.body,
        pendingAsk: '',
        children: session.collected.children,
        postalCode: session.collected.postalCode,
      },
      deps,
    );
    if (offScript) {
      await sendAndRecord(database, ctx, offScript.body, deps, recorded.transcript);
      heldForQuestion = true;
    }
  }

  if (heldForQuestion) {
    next = step;
  } else if (step === 'turtle') {
    // A session parked here before the year-find turn sent the asks itself.
    next = await sendPostYearFindLadder(
      database,
      {
        familyId,
        parentUserId: userId,
        phoneE164,
        language,
        now,
        inbound,
        send: (body, templateKey) =>
          sendAndRecord(database, ctx, body, deps, recorded.transcript, templateKey),
      },
      deps,
    );
  } else if (step === 'name') {
    const asked = await askParentCallName(database, {
      familyId,
      parentUserId: userId,
      language,
      send: (body, templateKey) =>
        sendAndRecord(database, ctx, body, deps, recorded.transcript, templateKey),
    });
    next = asked ? 'name_reply' : 'calendar';
  } else if (step === 'name_reply' && isSoftLadderAck(inbound.body)) {
    // The year-find turn already sent the name. "cool" is not a name.
    next = 'name_reply';
  } else if (step === 'name_reply') {
    const captured = await handleNameCaptureReply(
      database,
      { familyId, parentUserId: userId, body: inbound.body, now },
      defaultNameCaptureDeps(),
    );
    if (captured.status === 'captured') {
      await sendAndRecord(database, ctx, captured.reply, deps, recorded.transcript);
    }
    next = 'calendar';
  } else if (step === 'calendar' || step === 'gmail') {
    await sendYearConnectorCards(
      database,
      {
        familyId,
        parentUserId: userId,
        phoneE164,
        language,
        now,
        ridesReply: true,
        only: step === 'calendar' ? 'gcal' : 'gmail',
      },
      { transport: deps.transport, threadMessage: deps.threadMessage },
    );
    next = step === 'calendar' ? 'gmail' : 'coparent';
  } else {
    const pipe = messagingPipe(inbound);
    const from = pipe.channel === 'imessage' ? linqFromE164() : null;
    const coparentAsk =
      pipe.channel === 'imessage'
        ? from
          ? linqCoParentAsk(formatLinqLineForParent(from), language)
          : LINQ_GROUP_LINE_MISSING_TEXT[language]
        : CO_PARENT_ASK_BY_LANGUAGE[language];
    await sendAndRecord(
      database,
      ctx,
      coparentAsk,
      deps,
      recorded.transcript,
      INTAKE_COPARENT_ASK_TEMPLATE_KEY,
    );
    next = null;
    closed = true;
  }

  await saveSession(
    database,
    session,
    {
      state: closed ? 'complete' : 'awaiting_ladder',
      ...(closed ? { closedAt: now } : {}),
      lastProviderId: inbound.providerId,
      transcript: recorded.transcript,
      ladderNext: next,
      ladderLanguage: language,
    },
    now,
  );
  return { status: 'ladder_advanced', step, closed };
}

/**
 * The consent acknowledgment, whole. The call-name is the next text, not a tail
 * on this one. "Excited to help" and "no action needed" do not belong on a yes.
 */
function assentAck(language: ReplyLanguage): { body: string; asked: boolean } {
  return { body: ASSENT_ACK_BY_LANGUAGE[language], asked: false };
}

/**
 * The locked call-name line, its own bubble, in the same turn as the year find
 * and after the turtle card when that card shared.
 *
 * "What should I call you?" when there is no safe Google given name, and
 * "Can I call you {first}?" when there is. The composer is not called. A French
 * reply skips the English line. A parent who already has a name, or who was
 * already asked, is not asked again. A lookup that throws is logged and does
 * not hold the inbox or co-parent asks (rule #11).
 */
async function askParentCallName(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    language: ReplyLanguage;
    send: (body: string, templateKey: string) => Promise<unknown>;
  },
): Promise<boolean> {
  try {
    return await maybeSendParentCallName(
      database,
      {
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        // Year-open (and a later earned watch reply) already chose this moment.
        // An empty first radar still asks here. A later find asks only if this did not.
        isWin: true,
        language: args.language,
      },
      async (body, templateKey) => {
        await args.send(body, templateKey);
      },
    );
  } catch (err) {
    console.error(
      { familyId: args.familyId, err: err instanceof Error ? err.constructor.name : 'unknown' },
      'intake: parent name ask failed (inbox and co-parent still go out)',
    );
    return false;
  }
}

async function handleKeyword(
  database: Database,
  args: {
    match: IntakeKeywordMatch;
    phoneE164: string;
    inbound: Inbound;
    session: IntakeSession | null;
    now: Date;
  },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { match, phoneE164, inbound, session, now } = args;
  // The language comes WITH the keyword rather than from `replyLanguage`, and this is the
  // one turn where that matters: the body that got here IS the token, so there is no
  // sentence to read French out of. AIDE would have resolved to English (the detector
  // deliberately refuses to decide on it — it is also an English noun) and DEBUT is a word
  // it has never heard of, which is exactly what CTA v2.1 §3.1 forbids.
  const { keyword, language } = match;
  // VIL-348 · WHO ANSWERS. The provider's own keyword handling may have matched this
  // exact word and already replied to the sender; where it did, the inbound says so and
  // Hale's acknowledgment would be the second confirmation of one instruction. Every
  // ledger write below runs either way — the provider's opt-out list is not Hale's
  // consent record, and a STOP that revoked nothing because a carrier answered first is
  // the CASL failure, not the extra text.
  const providerAnswered = inbound.providerAnsweredKeyword === keyword;

  if (keyword === 'stop') {
    return handleStop(
      database,
      { phoneE164, inbound, session, now, language, providerAnswered },
      deps,
    );
  }

  if (keyword === 'help') {
    const ack: KeywordAck = providerAnswered ? 'provider_answered' : 'sent';
    if (!session) {
      // No session to transcribe against, but the number may still be an ENROLLED
      // parent's (intake long over) — their ledger must show this send (rule #6). A
      // stranger's HELP stays unrecorded by structural necessity, not omission:
      // channel_messages.family_id is NOT NULL, so there is no row it could occupy.
      //
      // The send and its ledger row go TOGETHER or not at all: a suppressed reply that
      // still wrote an outbound row would put a message in a parent's receipts that
      // Hale never sent.
      if (!providerAnswered) {
        const { providerMessageId } = await deps.transport.send({
          to: phoneE164,
          body: HELP_REPLY_BY_LANGUAGE[language],
        });
        const enrolled = await resolveVerifiedChannelByPhone(database, phoneE164);
        if (enrolled) {
          await writeChannelMessage(
            database,
            { familyId: enrolled.familyId, parentUserId: enrolled.userId },
            {
              direction: 'out',
              body: HELP_REPLY_BY_LANGUAGE[language],
              providerId: providerMessageId,
              at: now.toISOString(),
              ...messagingPipe(inbound),
            },
            now,
          );
        }
      }
      return { status: 'helped', ack };
    }
    const ctx = sendContext({ session, phoneE164, inbound, now });
    const recorded = await recordInbound(database, ctx, inbound, session.transcript);
    // Suppressed at THIS call site rather than inside `sendAndRecord`: that helper is
    // shared with fourteen other turns and has no business learning about keywords. The
    // inbound is still recorded and the session still closed on this turn's provider id,
    // so a carrier retry is still a duplicate rather than a second HELP.
    const transcript = providerAnswered
      ? recorded.transcript
      : (
          await sendAndRecord(
            database,
            ctx,
            HELP_REPLY_BY_LANGUAGE[language],
            deps,
            recorded.transcript,
          )
        ).transcript;
    await saveSession(database, session, { transcript, lastProviderId: inbound.providerId }, now);
    return { status: 'helped', ack };
  }

  // START. If the number was unsubscribed AND its owner still holds a seat, the keyword
  // itself is express re-consent (see channel-state.ts) — otherwise it opens a fresh
  // conversation, because a number whose seat is gone has no household to re-enter.
  const owner = await findReenrollableChannelOwner(database, phoneE164);
  if (owner) {
    await reenrolOnStart(database, { ...owner, phoneE164, verbatimReply: inbound.body }, now);
    if (providerAnswered) return { status: 'restarted', ack: 'provider_answered' };
    try {
      const { providerMessageId } = await deps.transport.send({
        to: phoneE164,
        body: START_ACK_BY_LANGUAGE[language],
      });
      // The re-enrolment ack is a real outbound to a known family: ledger it (rule #6).
      // Inside the try with its own send, so a refused ack writes no row claiming one.
      await writeChannelMessage(
        database,
        { familyId: owner.familyId, parentUserId: owner.userId },
        {
          direction: 'out',
          body: START_ACK_BY_LANGUAGE[language],
          providerId: providerMessageId,
          at: now.toISOString(),
          ...messagingPipe(inbound),
        },
        now,
      );
    } catch (error) {
      // VIL-348 · THE STOP → DEBUT ASYMMETRY, where it actually bites. An opt-out list
      // that holds STOP but not the word this parent just sent will refuse every send to
      // this number — 21610 — although Hale has just re-enrolled them. The refusal is
      // permanent, so there is nothing to retry: 500ing here would only earn a webhook
      // retry that fails identically, and it would do it AFTER the consent write.
      //
      // The outcome says so rather than swallowing it. Hale cannot fix this from here —
      // the remedy is that the provider's keyword set has to hold every word Hale prints
      // (keywords.ts) — but a re-enrolment nobody can be told about must not read the
      // same as one that landed. A TRANSIENT failure still throws and is still retried.
      if (!(error instanceof TwilioSendError && error.permanent)) throw error;
      return { status: 'restarted', ack: 'provider_refused' };
    }
    return { status: 'restarted', ack: 'sent' };
  }
  if (session) {
    return { status: 'ignored', reason: 'no_open_conversation' };
  }
  return greet(database, { phoneE164, inbound, now, joinTag: joinTagFromBody(inbound.body) }, deps);
}

async function handleStop(
  database: Database,
  args: {
    phoneE164: string;
    inbound: Inbound;
    session: IntakeSession | null;
    now: Date;
    /** The language of the keyword that got here — ARRET is answered in French. */
    language: ReplyLanguage;
    /** VIL-348 — the provider matched this STOP and already confirmed it to the sender.
     * Suppresses HALE'S ack and nothing else: every revocation below still runs. */
    providerAnswered: boolean;
  },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { phoneE164, inbound, session, now, language, providerAnswered } = args;

  // VIL-241 · "Reply STOP anytime" is printed on the invite, so it has to reach the
  // invite: a STOP from someone we asked but who never accepted closes the invitation
  // itself. Otherwise the only promise we made them would cover nothing.
  await declineOpenInviteOnStop(database, phoneE164, now);

  // VIL-245 · the same promise, printed on every party-guest text. A guest is not a
  // parent and has no channel to revoke — their consent lives on the RSVP row — so a
  // STOP has to reach that row directly, and it erases the stored number along with the
  // opt-in: the consent was the only basis for holding a non-user's number at all.
  await optOutGuestRemindersOnStop(database, phoneE164, now);

  // A STOP after provisioning must revoke the real channel + append the consent
  // withdrawal + audit — the enrolment engine already owns that transaction, so this
  // reuses it rather than writing a second revocation path that could drift from it.
  // Per-USER by construction: a caregiver's STOP revokes the caregiver's channel and
  // leaves every parent in the household subscribed.
  const owner =
    session?.familyId && session.userId
      ? { userId: session.userId, familyId: session.familyId }
      : await resolveVerifiedChannelByPhone(database, phoneE164);
  if (owner) {
    await revokeSmsChannel(database, { userId: owner.userId, familyId: owner.familyId }, { now });
  }

  // Closed BEFORE the ack, never after: the unsubscribe is the instruction, the ack is
  // a courtesy, and a courtesy that fails must not roll the instruction back.
  if (session) {
    await saveSession(
      database,
      session,
      { state: 'stopped', closedAt: now, lastProviderId: inbound.providerId },
      now,
    );
  }

  // The one final confirmation carriers expect, and then silence. ONE — so where the
  // provider has already sent it, Hale sends nothing and writes no outbound row: a
  // parent who asked to be left alone should not be told twice that they will be.
  if (providerAnswered) return { status: 'stopped', ack: 'provider_answered' };

  try {
    const { providerMessageId } = await deps.transport.send({
      to: phoneE164,
      body: STOP_ACK_BY_LANGUAGE[language],
    });
    // The ack is the last outbound this family will get, and it must be on the record
    // like every other (rule #6). Only when an OWNER exists: a guest's or invitee's
    // STOP has no family row to ledger against (channel_messages.family_id NOT NULL),
    // and their consent lives on the RSVP/invite rows handled above.
    if (owner) {
      await writeChannelMessage(
        database,
        { familyId: owner.familyId, parentUserId: owner.userId },
        {
          direction: 'out',
          body: STOP_ACK_BY_LANGUAGE[language],
          providerId: providerMessageId,
          at: now.toISOString(),
          ...messagingPipe(inbound),
        },
        now,
      );
    }
  } catch (error) {
    // A PERMANENT refusal means there is no ack to retry. 21610 above all: Twilio
    // refusing to text a number that has opted out AT THE CARRIER — the exact number a
    // STOP creates — and it has already sent its own advisory there, so the confirmation
    // IS delivered, by them. The rest (21211, 21614, 21408) mean the handset cannot be
    // reached at all. Either way, 500ing the webhook over an undeliverable courtesy
    // would fail the one message we are legally required to get right. A TRANSIENT
    // failure is still a failure: it throws, and the retry finds the session closed and
    // sends the ack again.
    if (!(error instanceof TwilioSendError && error.permanent)) throw error;
  }
  return { status: 'stopped', ack: 'sent' };
}

export type { IntakeState };
