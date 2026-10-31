import { type Database, schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import type { AnalyticsEvent } from '~/lib/analytics/events';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import {
  declineOpenInviteOnStop,
  loadLapsedInviteByPhone,
  loadOpenInviteByPhone,
} from '~/lib/channel/caregiver/invites';
import {
  type CaregiverDeps,
  type CaregiverOutcome,
  type CoParentOutcome,
  type LapsedInviteOutcome,
  type OpenQuestionsForParent,
  handleInviteReply,
  handleKnownNumberInbound,
  handleLapsedInviteReply,
} from '~/lib/channel/caregiver/route';
import { readConsent } from '~/lib/channel/consent-reply';
import { defaultFounderPingPorts, offerFounderWelcome } from '~/lib/channel/founder/ping';
import type { IdentityAskVoice } from '~/lib/channel/identity/ask-voice';
import { PARENT_NAME_ASK_TEMPLATE_KEY } from '~/lib/channel/identity/asked';
import { parentNeedsName, storeModelParentName } from '~/lib/channel/identity/name-reply';
import {
  confirmHeldGivenName,
  loadParentCallName,
  maybeSendParentCallName,
  releaseGoogleGivenName,
  safeGivenName,
} from '~/lib/channel/identity/parent-call-name';
import { type ParentRoleGuess, storeParentRole } from '~/lib/channel/identity/parent-role';
import { isJoinCode } from '~/lib/channel/join/code';
import { type JoinOutcome, handleJoinArrival } from '~/lib/channel/join/route';
import { type ReplyLanguage, localeFor } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { linqFromE164, linqGroupOnboardingV2Enabled } from '~/lib/channel/linq/config';
import {
  deliverHaleLinqContactCard,
  finishCardWithinReplyBudget,
  haleContactCardDay,
  shareHaleContactCardOnce,
} from '~/lib/channel/linq/contact-card';
import { parseCoParentNumberReply } from '~/lib/channel/linq/coparent-invite';
import { LINQ_GROUP_TRIGGER_PHRASE, formatLinqLineForParent } from '~/lib/channel/linq/group';
import { linkPreviewUrl, sendLinqLinkPreview } from '~/lib/channel/linq/link-preview';
import { openChosenHouseholdGroup } from '~/lib/channel/linq/open-chosen-group';
import {
  plainTextWithoutLinks,
  readSendRefusal,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import type { SaidLineWriter } from '~/lib/channel/voice/said-line';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone, revokeSmsChannel } from '~/lib/channels/sms-consent-core';
import { recordCommitment } from '~/lib/commitments/ledger';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { recordCheckpointTold } from '~/lib/health/told';
import { writeFact } from '~/lib/memory/facts';
import { reportFirstHelloFailure } from '~/lib/monitoring/failure-page';
import { optOutGuestRemindersOnStop } from '~/lib/party/store';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { recordActivityOffers, withSourceUrl } from '~/lib/village/live';
import { groupsFromFindBody } from './activity-map';
import type { IntakeAnswerComposer } from './answer';
import {
  findReenrollableChannelOwner,
  findRevokedChannelOwner,
  reenrolOnStart,
} from './channel-state';
import { coldStartLadderEnabled } from './cold-start/flags';
import { ageCorrectionFact, kidFirstName } from './cold-start/ladder';
import { declineOptionalAsk, gateOptionalAsk, recordOptionalAsk } from './cold-start/ledger';
import { type ConnectorOfferLabel, sendYearConnectorCards } from './connector-offer';
import {
  INTAKE_COPARENT_ASK_TEMPLATE_KEY,
  type IntakeGap,
  sourceCodeFromBody,
  venueForCode,
} from './copy';
import { deriveDateOfBirth, parseIntakePostal, summarizeChildren } from './derive';
import type { ExtractedChild, IntakeCollected, IntakeExtractor } from './extract';
import { firstTouchLocationCardEnabled } from './first-touch-flag';
import { type FirstTouchPlace, placeFromVenue } from './first-touch-place';
import {
  type FriendChild,
  type FriendFallback,
  type FriendStep,
  type FriendVoiceComposer,
  type FriendVoiceInput,
  type FriendVoiceResult,
  OPENING_ATTEMPT_TIMEOUT_MS,
  type SpeakOptions,
  pageOncePerDay,
  speakFriend,
  turnsFromTranscript,
} from './friend-voice';
import { identityChallengeReply } from './identity-challenge';
import type { ReplyIntent, ReplyIntentReader } from './intent';
import { isCheerUpAsk, isLiveLookupAsk } from './live-lookup';
import { isOfficialPageAsk } from './official-page';
import {
  type CoparentGroupMode,
  type OnboardingCapture,
  type OnboardingChecklist,
  type OnboardingItem,
  agesAreComplete,
  applyNameControl,
  coldStartQuestionIsStale,
  kidsAreNamed,
  lastTranscriptAt,
  onboardingMissing,
  storedFromCapture,
} from './onboarding-turn';
import { holdSender, releaseSender } from './opt-out-hold';
import {
  type OptOutReader,
  type OptOutReading,
  isCrisisReading,
  isIdentityReading,
  readTextOnce,
  readTurnOnce,
  sharedOptOutReader,
} from './opt-out-reader';
import { type IntakeLocation, type ProvisionChild, provisionFromIntake } from './provision';
import { INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY, type RadarComposer } from './radar';
import { FIRST_FIND_BEAT, FIRST_FIND_DUE_HOURS } from './radar-voice';
import { writeScheduleAdds } from './schedule-adds';
import {
  type ColdStartProgress,
  type FirstTouchGiven,
  type FirstTouchPersisted,
  type FirstTouchScheduled,
  type IntakeLadderStep,
  type IntakeSession,
  type IntakeState,
  type TranscriptEntry,
  createSession,
  linqContactCardShareBlocked,
  loadOpenSession,
  saveSession,
  transcriptHasOutbound,
} from './session';
import type { SignupStepReader } from './signup-step';
import type { ChannelTransport } from './transport';
import { claimIntakeTurn, completeIntakeTurn } from './turn-claim';
import { IMPLIED_WATCH_BASIS, recordWatchConsent } from './watch-consent';

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
  /**
   * Friend-voice onboarding replies. Required in production wiring. A test that
   * leaves it off gets the named fallback inside {@link speakFriend}.
   */
  friendVoice?: FriendVoiceComposer;
  /**
   * #868 · the model reads an opt-out from any wording. Read after the carrier STOP
   * keyword (which still revokes first) and before any onboarding or group turn.
   * Absent in tests that do not exercise it.
   */
  optOutReader?: OptOutReader;
  /** #868: writes the lines that used to be fixed (identity, a crisis the answer model flagged). */
  saidLine?: SaidLineWriter;
  /** #868 · failed-read hold store; defaults to opt_out_read_holds. */
  optOutHold?: OptOutHoldPort;
  /** Answers a question the parent asked INSTEAD of answering intake's (answer.ts).
   * Required, never nullable (rule #11): withholding it would restore the exact bug it
   * closed — an off-script question silently becoming a re-ask — and its own "there was
   * nothing to answer" is a named outcome, so absence has no meaning left to carry. */
  answerComposer: IntakeAnswerComposer;
  /**
   * Whether a mid-signup text answers the open step. The model reads it, in
   * any wording and any language. Absent is `not_configured` and the ladder
   * continues. A failed read, or a read that says this is not an answer,
   * closes the session so the door can hand the parent's own words to the
   * coach, which replies in the language they wrote in.
   */
  signupStepReader?: SignupStepReader;
  /** Reads a consent reply during intake. Absence is named and assents to nothing. */
  consent?: import('~/lib/channel/consent-reply').ConsentReader;
  /** Writes a consent ask during intake. Absence is named and sends nothing. */
  consentAsk?: import('~/lib/channel/consent-ask').ConsentAskWriter;
  /** What to call this parent, after a real radar win (PR #689). Intake's consent
   * tail does not call it: a name ask on the assent acknowledgment is the bot voice
   * this turn exists to stop. The dep stays required so a missing composer is a
   * wiring error, not a silent skip of the later ask. */
  identityAsk: IdentityAskVoice;
  limiter: RateLimiter;
  /**
   * Live "this week" lookup for the first-touch ladder. Absent is named
   * `not_configured` and the locked empty line goes out — never a guess.
   */
  weekFinder?: ActivityFinder | null;
  /**
   * Clear the iMessage typing bubble before a reply goes out. The inbound door
   * arms it. Absent on SMS and on a test that never armed one: there is no
   * bubble to clear, and that is not a skipped send. A throw is logged and
   * the reply still leaves.
   */
  stopTyping?: () => Promise<void>;
  /**
   * Send another typing start. The inbound door arms the bubble at receipt.
   * A search or a model call can outlive Linq's hold, so each slow step
   * re-arms. Absent when nothing was armed.
   */
  keepTyping?: () => void;
  /** The funnel's two milestones. Optional because the DEFAULT IS THE REAL EFFECT —
   * `captureServerEvent`, which already names its own absence on a dead PostHog key
   * (rule #11) — so this is a test seam, never a way to withhold the send. */
  capture?: typeof captureServerEvent;
  now?: Date;
}

export type KeywordAck = 'sent' | 'provider_answered' | 'provider_refused' | 'voice_unsent';

export type IntakeOutcome =
  /**
   * A new parent's opening turn sent nothing: the model could not write it. Never a
   * step, because a step says Hale replied (rule #11). The session stays recoverable —
   * awaiting_details with an inbound and no outbound — so the parent's own re-text
   * re-runs the opening and the first-reply sweep owes it one reply.
   */
  | { status: 'first_touch_unsent'; reason: FriendFallback }
  | { status: 'greeted' }
  /** VIL-385 ladder beat that is not yet a provisioned family. */
  | { status: 'first_touch'; step: 'place_asked' | 'place_waiting' | 'find_sent' | 'ages_waiting' }
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
  /**
   * `group_stop` — a STOP inside the family group, with group onboarding v2 on. It is
   * about the group (linq/roster-stop.ts answers it), so it revokes no channel here and
   * nothing is acknowledged into the group from this door.
   */
  | {
      status: 'ignored';
      // `group_turn_during_intake` (group onboarding v2): a family-group message from a
      // number whose own 1:1 intake is still open. Onboarding is a 1:1 conversation, so
      // nothing of it is answered into the group.
      reason: 'invalid_number' | 'no_open_conversation' | 'group_turn_during_intake' | 'opted_out';
    }
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
  // (inbound-route.ts), and a redemption has already been answered.
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
  /** A Linq group turn. The Name and Photo card is 1:1 only and never shares here. */
  isGroup?: boolean;
  /** See `InboundMessage.budget` (intake/transport.ts). Absent is the sender's. */
  budget?: 'sender' | 'chat';
  /** VIL-348 — the provider already answered this keyword itself; see
   * `InboundMessage.providerAnsweredKeyword` (intake/transport.ts) for what that means
   * and what it does NOT suppress. Optional here for the same reason it is optional
   * there: a caller written before the provider could answer a keyword means "it
   * answered nothing", which is exactly what absent resolves to. */
  providerAnsweredKeyword?: ProviderKeyword | null;
}

/** The caregiver lane's ports, taken off intake's deps. The names differ on purpose. */
function caregiverPorts(deps: IntakeDeps): CaregiverDeps {
  return {
    transport: deps.transport,
    threadMessage: deps.threadMessage,
    openQuestions: deps.openQuestions,
    consent: deps.consent,
    ask: deps.consentAsk,
  };
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

  // 2. #868 · no keyword list. The opt-out reader reads every turn, in any wording and
  // any language; a stop is never throttled away (step 3 still reads an over-limit turn).
  const reader = deps.optOutReader ?? sharedOptOutReader();

  // 3. Rate limit, keyed by the BLIND INDEX (the raw number never reaches the limiter
  // table). Over the limit we go SILENT rather than replying "slow down": a reply is
  // itself an outbound SMS, so answering a flood would hand an SMS-pumping attacker
  // exactly the amplification they came for. The turn is still read, so a stop in any
  // wording still revokes; nothing else runs over the limit.
  // A family-group turn the Linq door already charged to the chat spends nothing here.
  if (inbound.budget !== 'chat') {
    const decision = await deps.limiter.check(phoneHash, INTAKE_ROUTE, RATE_LIMITS[INTAKE_ROUTE]);
    if (!decision.allowed) {
      const reading = await readTurnOnce(reader, inbound, {
        text: inbound.body,
        language: null,
      });
      await settleOptOutHold(database, phoneHash, inbound.body, reading, now, deps.optOutHold);
      if (reading?.intent === 'stop') {
        return handleStop(
          database,
          {
            phoneE164,
            inbound,
            session: await loadOpenSession(database, phoneE164),
            now,
            providerAnswered: inbound.providerAnsweredKeyword === 'stop',
            confirmation: reading.confirmation,
          },
          deps,
        );
      }
      return { status: 'rate_limited' };
    }
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

  // 5. "Stop texting me" or "start again", in any wording, read by the model. Deliberately
  // UNCLAIMED: a stop is a legal instruction, its handling is idempotent, and a claim here
  // would refuse the resend that re-runs a stop whose first attempt crashed. The model
  // writes the one confirmation; an empty one sends nothing (the revocation still runs).
  if (inbound.body.trim().length > 0) {
    const reading = await readTurnOnce(reader, inbound, {
      text: inbound.body,
      language: session?.ladderLanguage ?? null,
    });
    await settleOptOutHold(database, phoneHash, inbound.body, reading, now, deps.optOutHold);
    if (reading?.intent === 'stop') {
      return handleStop(
        database,
        {
          phoneE164,
          inbound,
          session,
          now,
          providerAnswered: inbound.providerAnsweredKeyword === 'stop',
          confirmation: reading.confirmation,
        },
        deps,
      );
    }
    // A start re-enrols a number that stopped. Not a stopped number with a seat → the
    // turn goes on as ordinary conversation.
    if (reading?.intent === 'start') {
      const restarted = await restartFromReader(
        database,
        {
          phoneE164,
          inbound,
          now,
          confirmation: reading.confirmation,
          providerAnswered: inbound.providerAnsweredKeyword === 'start',
        },
        deps,
      );
      if (restarted) return restarted;
    }
  }

  // 5b. Group onboarding v2 — onboarding is this number's 1:1 conversation. A message they
  // send in the family group while it is open is not an onboarding turn, and its reply
  // must not land in front of the whole group. Named, and nothing is sent.
  if (
    inbound.isGroup === true &&
    session &&
    session.state !== 'stopped' &&
    linqGroupOnboardingV2Enabled()
  ) {
    return { status: 'ignored', reason: 'group_turn_during_intake' };
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
      return handleInviteReply(database, { invite, phoneE164, inbound, now }, caregiverPorts(deps));
    }

    const existing = await resolveVerifiedChannelByPhone(database, phoneE164);
    if (existing) {
      // Either a caregiver (who gets the one scoped line) or a parent adding one. Any
      // other message keeps the old silence.
      const outcome = await handleKnownNumberInbound(
        database,
        { owner: existing, phoneE164, inbound, now },
        caregiverPorts(deps),
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
    if (!invite) {
      const lapsed = await loadLapsedInviteByPhone(database, phoneE164, now);
      if (lapsed) {
        const read = await readConsent(deps.consent, {
          question: 'caregiver_invite',
          text: inbound.body,
        });
        if (read && read.verdict !== 'neither') {
          return claimedTurn(database, inbound, now, () =>
            handleLapsedInviteReply(
              database,
              { invite: lapsed, phoneE164, inbound, now },
              caregiverPorts(deps),
            ),
          );
        }
      }
    }

    // #868 · an opt-out stops all texting at once. A number whose channel was
    // revoked (carrier STOP or a model-read opt-out) and not re-enrolled is never
    // greeted again, 1:1 or in a group, and is not handed to the coach either. Only
    // START (step 5) brings it back.
    if (await findRevokedChannelOwner(database, phoneE164)) {
      return { status: 'ignored', reason: 'opted_out' };
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

  if (session.state === 'awaiting_place' || session.state === 'awaiting_ages') {
    return claimedTurn(database, inbound, now, () =>
      continueFirstTouch(database, { session, phoneE164, inbound, now }, deps),
    );
  }

  if (session.state === 'awaiting_cold_start') {
    return claimedTurn(database, inbound, now, () =>
      continueColdStart(database, { session, phoneE164, inbound, now }, deps),
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
      deliverFirstHelloReporting(
        database,
        { session, phoneE164, inbound, now },
        deps,
        session.sourceCode,
      ),
    );
  }

  return claimedTurn(database, inbound, now, () =>
    handleDetails(database, { session, phoneE164, inbound, now }, deps),
  );
}

/**
 * Run one intake turn under the P1-4 provider-id claim (turn-claim.ts): the first
 * delivery to claim the sid runs; every later one — including a Linq resend racing
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
  pipe: { channel: 'sms' | 'imessage'; chatId: string | null; isGroup: boolean };
}

function messagingPipe(inbound: Inbound): SendContext['pipe'] {
  if (inbound.transport === 'imessage') {
    return {
      channel: 'imessage',
      chatId: inbound.chatId ?? null,
      isGroup: inbound.isGroup === true,
    };
  }
  return { channel: 'sms', chatId: null, isGroup: false };
}

/** One in-flight share per session object, so a second bubble in the same turn cannot double-post. */
const linqCardStarted = new WeakSet<IntakeSession>();

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
async function quietStopTyping(deps: IntakeDeps): Promise<void> {
  if (!deps.stopTyping) return;
  try {
    await deps.stopTyping();
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'linq: typing indicator did not stop',
    );
  }
}

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
  if (body.trim().length === 0) {
    console.error({ reason: 'empty_outbound' }, 'intake: outbound not sent');
    return { transcript, channelMessageId: null };
  }
  await quietStopTyping(deps);
  const sent = await sendResolvingNewChat(deps.transport, { to: ctx.phoneE164, body });
  const wireBody = sent.linkOmitted ? plainTextWithoutLinks(body) : body;
  const channel = sent.transport === 'imessage' ? 'imessage' : ctx.pipe.channel;
  const chatId = sent.transport === 'imessage' ? (sent.chatId ?? ctx.pipe.chatId) : ctx.pipe.chatId;
  await finishCardWithinReplyBudget(
    shareLinqCardAfterFirstOutbound(database, ctx, { channel, chatId }),
  );
  const entry: TranscriptEntry = {
    direction: 'out',
    body: wireBody,
    providerId: sent.providerMessageId,
    at: ctx.now.toISOString(),
    channel,
    chatId,
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
      body: wireBody,
    });
    if (channel === 'imessage' && chatId && !sent.linkOmitted) {
      const preview = linkPreviewUrl(wireBody);
      if (preview) {
        await sendLinqLinkPreview({
          channel: 'imessage',
          chatId,
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
/** A turn that is answered by silence: the seam ends the turn and sends nothing. */
const HELD_SILENT = { body: '', source: 'safety' as const };

async function offScriptReply(
  args: {
    parentWords: string;
    pendingAsk: string;
    children: readonly ExtractedChild[];
    postalCode?: string | null;
    language?: ReplyLanguage | null;
  },
  deps: IntakeDeps,
): Promise<{ body: string; source: 'composed' | 'safety' | 'identity' } | null> {
  // A crisis was already routed by the turn's reader before this seam (#868). The
  // identity disclosure is the whole turn, written by the model from the facts.
  const identity = await identityChallengeReply(
    args.parentWords,
    deps.saidLine,
    await readTextOnce(deps.optOutReader, {
      text: args.parentWords,
      language: null,
    }),
  );
  if (identity.challenge) {
    return identity.body ? { body: identity.body, source: 'identity' } : HELD_SILENT;
  }
  const outcome = await deps.answerComposer.compose(args);
  if (outcome.status === 'mental_crisis') {
    // The answer model saw a crisis the reader did not. Still the model's words.
    const written = await deps.saidLine?.write({
      purpose: 'crisis_mental',
      language: null,
      parentWords: args.parentWords,
      facts: { crisisLine: '988 (call or text, Canada and US)', emergency: '911' },
    });
    if (!written) {
      console.error('intake crisis: answer model flagged a crisis, no reply written - page #ops');
      return HELD_SILENT;
    }
    return { body: written, source: 'safety' };
  }
  if (outcome.status === 'safety') {
    // #868: the 811 line is the model's words; the code checks both numbers are in it.
    const written = await deps.saidLine?.write({
      purpose: 'health',
      language: null,
      parentWords: args.parentWords,
      facts: { healthLine: 'Health811 (Ontario), call 811, any time', emergency: '911' },
      mustInclude: ['811', '911'],
    });
    if (!written) {
      console.error('intake health: no line written - nothing sent, page #ops');
      return HELD_SILENT;
    }
    return { body: written, source: 'safety' };
  }
  if (outcome.status === 'answered') return { body: outcome.body, source: 'composed' };
  // VIL-326 / VIL-327: unavailable / empty must not fall back to the greet or
  // the pending ask alone when they asked a real question. Safety stays above.
  // #868: the not-posted / no-source / cheer-up lines are the model's words now;
  // the code only picks which one is owed. Nothing written means nothing sent.
  const purpose = isOfficialPageAsk(args.parentWords)
    ? 'not_posted'
    : isLiveLookupAsk(args.parentWords)
      ? 'no_source'
      : isCheerUpAsk(args.parentWords)
        ? 'cheer_up'
        : null;
  if (purpose === null) return null;
  const written = await deps.saidLine?.write({
    purpose,
    language: null,
    parentWords: args.parentWords,
    facts: {},
  });
  if (!written) {
    console.error({ purpose }, 'intake answer fallback: no line written - nothing sent');
    return HELD_SILENT;
  }
  return { body: written, source: 'composed' };
}

/**
 * The opening turn of a number Hale has never heard from: `intake_started` plus
 * `first_text_received`, the SMS funnel's first step. Keyed on the intake session id,
 * like the rest of intake (no phone, no hash of one). `source_code` is the poster/site
 * code the first text carried (session.sourceCode, read by sourceCodeFromBody), and it
 * is ALSO set once on the person, so retention can break down by poster.
 */
async function reportOpening(
  deps: IntakeDeps,
  session: IntakeSession,
  inbound: Inbound,
  language: ReplyLanguage | null,
): Promise<void> {
  await reportIntakeStep(deps, 'intake_started', session.id, {
    source_code: session.sourceCode,
  });
  const channel = inbound.transport === 'imessage' ? 'imessage' : 'sms';
  try {
    await (deps.capture ?? captureServerEvent)(
      'first_text_received',
      session.id,
      {
        source_code: session.sourceCode,
        door: channel,
        channel,
        locale: language,
      },
      session.sourceCode ? { setOnce: { first_source_code: session.sourceCode } } : {},
    );
  } catch (err) {
    console.warn('intake analytics: first text not recorded', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/** Counts and elapsed time only — never a word of the transcript. Exported for tests. */
export function intakeShape(
  transcript: readonly TranscriptEntry[],
  now: Date,
): { step_count: number; duration_s?: number } {
  const inbound = transcript.filter((e) => e.direction === 'in');
  const first = inbound[0] ? Date.parse(inbound[0].at) : Number.NaN;
  return {
    step_count: inbound.length,
    ...(Number.isFinite(first)
      ? { duration_s: Math.max(0, Math.round((now.getTime() - first) / 1000)) }
      : {}),
  };
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
  // every Linq retry as details (VIL-332). Close the unfinished claim so the
  // retry can greet on a new session.
  try {
    return await deliverFirstHelloReporting(
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

/**
 * The first hello, and a page when it throws. Reporting happens before the
 * caller closes the session, and it never replaces the error the caller is
 * about to surface — a parent who got no hello is still a failed turn.
 */
async function deliverFirstHelloReporting(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
  sourceCode: string | null,
): Promise<IntakeOutcome> {
  try {
    return await deliverFirstHello(database, args, deps, sourceCode);
  } catch (err) {
    await reportFirstHelloFailure(database, {
      sessionId: args.session.id,
      familyId: args.session.familyId,
      err,
    });
    throw err;
  }
}

async function deliverFirstHello(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
  _sourceCode: string | null,
): Promise<IntakeOutcome> {
  return friendOnboardingTurn(database, args, deps, true);
}

/**
 * VIL-385. New parent, flag on. Place first unless the message already has one,
 * then a live week find, then ages. One place ask. No area-code guess.
 */
const REASK_CAP = 2;

async function friendSpeak(
  deps: IntakeDeps,
  transcript: readonly { direction: 'in' | 'out'; body: string }[],
  input: Omit<FriendVoiceInput, 'recentTurns'>,
  options?: Omit<SpeakOptions, 'page'> & {
    /** The family or session a miss is paged for: #ops hears once per kind per day. */
    pageScope?: string | null;
  },
) {
  deps.keepTyping?.();
  const { pageScope, ...speak } = options ?? {};
  // #868: whether they asked who Hale is comes from the turn's model read, not a regex.
  const identityAsked =
    input.identityAsked ??
    isIdentityReading(
      await readTextOnce(deps.optOutReader, {
        text: input.parentWords,
        language: input.language,
      }),
    );
  return speakFriend(
    deps.friendVoice,
    { ...input, identityAsked, recentTurns: turnsFromTranscript(transcript) },
    pageScope ? { ...speak, page: pageOncePerDay(deps.limiter, pageScope) } : speak,
  );
}

/** A judged model reply. Empty means the retries already paged #ops. */
function friendOutbound(spoken: FriendVoiceResult): string | null {
  if (spoken.source === 'unsent' || spoken.body.trim().length === 0) return null;
  return spoken.body;
}

/** Why a reply {@link friendOutbound} refused did not go out. A judged draft with no
 * words left carries no fallback of its own, and is the unusable case. */
function unsentReason(spoken: FriendVoiceResult): FriendFallback {
  return spoken.fallback ?? 'unusable';
}

function touchWithClarify(touch: FirstTouchPersisted, key: 'place' | 'ages'): FirstTouchPersisted {
  const prior = touch.clarify ?? { place: 0, ages: 0 };
  return {
    ...touch,
    clarify: { place: prior.place, ages: prior.ages, [key]: prior[key] + 1 },
  };
}

function linesOfFind(message: string): string[] {
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, ''));
}

function friendAddress(ctx: SendContext): 'tu' | 'vous' {
  return ctx.pipe.isGroup ? 'vous' : 'tu';
}

function friendFields(
  step: FriendStep,
  language: ReplyLanguage | null,
  address: 'tu' | 'vous',
  extra: Partial<Omit<FriendVoiceInput, 'step' | 'language' | 'address' | 'recentTurns'>> = {},
): Omit<FriendVoiceInput, 'recentTurns'> {
  return {
    step,
    language,
    address,
    introduce: false,
    parentWords: '',
    placeLabel: null,
    agesLabel: null,
    ageMonths: [],
    findLines: [],
    listKind: 'none',
    activity: null,
    day: null,
    parentName: null,
    ...extra,
  };
}

/**
 * #868 · a crisis, routed and answered by the model. The turn's one reader call
 * (opt-out-reader.ts, shared by {@link readTurnOnce}) decides an emergency or a
 * mental-health crisis in any wording and writes the reply that points to
 * emergency or crisis help. Null: not a crisis. `body` null: a crisis whose reply
 * came back empty — the turn still ends there (no onboarding ask to a person in
 * crisis) and the miss is logged loudly for #ops.
 */
async function crisisReply(
  inbound: Inbound,
  language: ReplyLanguage | null,
  deps: IntakeDeps,
): Promise<{ body: string | null } | null> {
  const reading = await readTurnOnce(deps.optOutReader, inbound, {
    text: inbound.body,
    language,
  });
  if (!isCrisisReading(reading)) return null;
  const body = reading.confirmation.trim();
  if (body.length === 0) {
    console.error(
      { intent: reading.intent },
      'intake crisis: the model routed a crisis but wrote no reply - nothing sent, page #ops',
    );
    return { body: null };
  }
  return { body };
}

/** The kids as the model sees them: name and age only, so a line's age fit lands on the right kid. */
function friendChildren(
  children: readonly { name: string | null; ageMonths: number | null }[],
): FriendChild[] {
  return children.map((child) => ({ name: child.name, ageMonths: child.ageMonths }));
}

/** Post-family sends do not append to the session transcript. The next model turn reads it. */
function threadForNext(
  transcript: TranscriptEntry[],
  inboundBody: string,
  inboundAt: string,
  outboundBody: string,
  now: Date,
): TranscriptEntry[] {
  const last = transcript.at(-1);
  const base =
    last?.direction === 'in' && last.body === inboundBody
      ? transcript
      : [
          ...transcript,
          { direction: 'in' as const, body: inboundBody, providerId: null, at: inboundAt },
        ];
  return [
    ...base,
    { direction: 'out' as const, body: outboundBody, providerId: null, at: now.toISOString() },
  ];
}

function friendStepForGap(gap: OnboardingItem | undefined, card: boolean): FriendStep {
  switch (gap) {
    case 'kids':
      return 'kids_names';
    case 'ages':
      return 'ages';
    case 'name':
      return 'names';
    case 'gmail':
      return 'email';
    case 'calendar':
      return 'calendar';
    case 'schedule':
      return 'schedule';
    case 'coparent':
      return 'coparent';
    case undefined:
      return 'ack';
    default:
      return card ? 'place_card' : 'place';
  }
}

/** Hale's iMessage line and the group phrase, when the chat is iMessage and the line is configured. */
function coparentJoinFor(ctx: SendContext, language: ReplyLanguage | null) {
  if (ctx.pipe.channel !== 'imessage') return null;
  const from = linqFromE164();
  if (!from) return null;
  const phrase =
    language === 'fr' || (language ?? '').startsWith('fr-')
      ? LINQ_GROUP_TRIGGER_PHRASE.fr
      : LINQ_GROUP_TRIGGER_PHRASE.en;
  return { line: formatLinqLineForParent(from), phrase };
}

/**
 * The real join data, appended under the model's prose like a URL. Never model-written.
 * Flag off is today's claim: the number and the phrase. Flag on appends the number
 * only after the model reads an existing iMessage group, and never a locked sentence
 * or a phrase to text.
 */
function coparentTrailer(
  join: { line: string; phrase: string } | null,
  mode: CoparentGroupMode | null,
): string | null {
  if (!join) return null;
  if (!linqGroupOnboardingV2Enabled()) return `${join.line}\n${join.phrase}`;
  return mode === 'existing' ? join.line : null;
}

/**
 * Flag on and the model chose a new group. Opens the household thread when a
 * co-parent phone is already confirmed, or starts the existing co-parent invite
 * when this message names a number that is not. Flag off returns before either.
 */
async function pursueNewHouseholdGroup(
  database: Database,
  args: {
    mode: CoparentGroupMode | null;
    familyId: string;
    parentUserId: string;
    parentPhoneE164: string;
    now: Date;
    inboundBody: string;
    ask?: import('~/lib/channel/consent-ask').ConsentAskWriter;
  },
  send: (body: string) => Promise<void>,
): Promise<void> {
  try {
    const outcome = await openChosenHouseholdGroup(database, {
      ...args,
      namedPhone: parseCoParentNumberReply(args.inboundBody),
      ask: args.ask,
    });
    if (outcome.status === 'invite_started') await send(outcome.reply);
  } catch (err) {
    console.warn(
      { familyId: args.familyId, code: err instanceof Error ? err.name : 'unknown' },
      'linq group: choosing a new group threw',
    );
  }
}

function scheduledForModel(given: FirstTouchGiven | null, language: ReplyLanguage | null) {
  return (given?.scheduled ?? []).map((row) => ({
    line: row.line,
    title: row.title,
    when: `${dayLabelFor(row.date, language)}${row.time ? ` ${row.time}` : ''}`,
    cadence: row.cadence,
  }));
}

function dayLabelFor(dayKey: string, language: ReplyLanguage | null): string {
  const [year, month, day] = dayKey.split('-').map((part) => Number(part));
  if (!year || !month || !day) return dayKey;
  return new Intl.DateTimeFormat(localeFor(language), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function givenFromStored(
  prior: FirstTouchGiven | null,
  stored: {
    parentName: string | null;
    parentRole: ParentRoleGuess | null;
    connectCalendar: boolean | null;
    connectGmail: boolean | null;
  },
  capture: {
    nameDeclined: boolean;
    kidsNamesDeclined: boolean;
    calendarLater: boolean;
    gmailLater: boolean;
    scheduleDone: boolean;
    coparentGroup: boolean | null;
    coparentGroupMode: CoparentGroupMode | null;
  },
  extra: { scheduled?: FirstTouchScheduled[] } = {},
): FirstTouchGiven | null {
  const scheduled = [...(prior?.scheduled ?? []), ...(extra.scheduled ?? [])];
  const given: FirstTouchGiven = {
    parentName: stored.parentName,
    activityPick: prior?.activityPick ?? null,
    connectCalendar: stored.connectCalendar,
    connectGmail: stored.connectGmail,
    parentRole: stored.parentRole,
    nameDeclined: prior?.nameDeclined === true || capture.nameDeclined,
    kidsNamesDeclined: prior?.kidsNamesDeclined === true || capture.kidsNamesDeclined,
    calendarLater: prior?.calendarLater === true || capture.calendarLater,
    gmailLater: prior?.gmailLater === true || capture.gmailLater,
    scheduleDone: prior?.scheduleDone === true || capture.scheduleDone,
    scheduled,
    coparentGroup: capture.coparentGroup ?? prior?.coparentGroup ?? null,
    coparentGroupMode: capture.coparentGroupMode ?? prior?.coparentGroupMode ?? null,
  };
  if (
    !given.parentName &&
    given.activityPick == null &&
    given.connectCalendar == null &&
    given.connectGmail == null &&
    !given.parentRole &&
    !given.nameDeclined &&
    !given.kidsNamesDeclined &&
    !given.calendarLater &&
    !given.gmailLater &&
    !given.scheduleDone &&
    scheduled.length === 0 &&
    given.coparentGroup == null
  ) {
    return null;
  }
  return given;
}

/** Nothing to schedule when the map had no lines. */
function scheduleKnown(given: FirstTouchGiven | null, lineCount: number): boolean {
  return lineCount === 0 || given?.scheduleDone === true;
}

function coparentKnown(given: FirstTouchGiven | null): boolean {
  return given?.coparentGroup != null;
}

/**
 * What the model read in the reply to the ladder's name ask: a typed name, a
 * yes or no to the held Google name, and the soft role. Nothing is read from
 * the raw text here.
 */
async function keepLadderName(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    capture: OnboardingCapture;
    heldGivenName: string | null;
  },
): Promise<void> {
  const { familyId, parentUserId, capture } = args;
  if (capture.parentName) {
    await storeModelParentName(database, { familyId, parentUserId, name: capture.parentName });
  } else if (capture.nameConfirmed === true && args.heldGivenName) {
    await confirmHeldGivenName(database, { familyId, parentUserId });
  } else if (capture.nameConfirmed === false) {
    await releaseGoogleGivenName(database, {
      familyId,
      userId: parentUserId,
      reason: 'confirm_declined',
    });
  }
  await keepParentRole(database, { familyId, userId: parentUserId, guess: capture.parentRole });
}

/** The parent's role, if the model read one, on the users row (VIL-417). */
async function keepParentRole(
  database: Database,
  args: { familyId: string; userId: string; guess: ParentRoleGuess | null | undefined },
): Promise<void> {
  if (!args.guess) return;
  const wrote = await storeParentRole(database, {
    familyId: args.familyId,
    parentUserId: args.userId,
    guess: args.guess,
  });
  console.info({ wrote, basis: args.guess.basis }, 'onboarding-friend: parent role');
}

function agesKnown(children: readonly { ageMonths: number | null }[]): boolean {
  return agesAreComplete(children);
}

function nameKnown(given: FirstTouchGiven | null, needsName: boolean): boolean {
  return !needsName || Boolean(given?.parentName) || given?.nameDeclined === true;
}

function kidsKnown(
  children: readonly { name: string | null }[],
  given: FirstTouchGiven | null,
): boolean {
  return given?.kidsNamesDeclined === true || kidsAreNamed(children);
}

function calendarAnswered(given: FirstTouchGiven | null): boolean {
  return given?.connectCalendar != null || given?.calendarLater === true;
}

function gmailAnswered(given: FirstTouchGiven | null): boolean {
  return given?.connectGmail != null || given?.gmailLater === true;
}

/**
 * One model turn for the pre-family ladder. The model returns the reply and
 * every fact the message contained. Code stores those facts and, once a place
 * and ages are both stored, provisions. It does not read the message to decide
 * which fact arrived.
 */
async function friendOnboardingTurn(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
  opening: boolean,
): Promise<IntakeOutcome> {
  const { session, inbound, now } = args;
  const ctx = sendContext(args);
  let language = session.ladderLanguage ?? session.firstTouch?.language ?? null;
  const recorded = await recordInbound(database, ctx, inbound, session.transcript);
  let transcript = recorded.transcript;
  const safety = await crisisReply(inbound, language, deps);
  if (safety) {
    if (safety.body) {
      ({ transcript } = await sendAndRecord(database, ctx, safety.body, deps, transcript));
    }
    await saveSession(
      database,
      session,
      {
        state: session.state === 'awaiting_ages' ? 'awaiting_ages' : 'awaiting_place',
        transcript,
        lastProviderId: inbound.providerId,
        ladderLanguage: language,
        firstTouch: session.firstTouch ?? {
          language,
          place: null,
          locationRequest: null,
        },
      },
      now,
    );
    return {
      status: 'first_touch',
      step: session.state === 'awaiting_ages' ? 'ages_waiting' : 'place_waiting',
    };
  }

  let place = session.firstTouch?.place ?? null;
  if (!place && opening) {
    const venue = venueForCode(session.sourceCode);
    const venuePlace = venue ? placeFromVenue(venue) : null;
    if (venuePlace) place = persistPlace(venuePlace);
  }
  let locationRequest = session.firstTouch?.locationRequest ?? null;
  let card = false;
  if (opening && !place) {
    const located = await resolveFirstTouchLocation(ctx, deps);
    locationRequest = located.locationRequest;
    card = located.accepted;
  }
  const priorGiven = session.firstTouch?.given ?? null;
  // Pre-family: the map, the schedule and the co-parent ask come after provisioning.
  const checklist: OnboardingChecklist = {
    postal: place != null,
    kids: kidsKnown(session.collected.children, priorGiven),
    ages: agesKnown(session.collected.children),
    name: Boolean(priorGiven?.parentName) || priorGiven?.nameDeclined === true,
    gmail: gmailAnswered(priorGiven),
    calendar: calendarAnswered(priorGiven),
    schedule: false,
    coparent: false,
  };
  const prior = {
    children: session.collected.children,
    postalCode: session.collected.postalCode,
    place: place
      ? {
          kind: place.kind,
          areaCoarse: place.areaCoarse,
          postalCode: place.postalCode,
          municipality: place.municipality as FirstTouchPlace['municipality'],
          city: place.city,
        }
      : null,
    parentName: priorGiven?.parentName ?? null,
    parentRole: priorGiven?.parentRole ?? null,
    connectCalendar: priorGiven?.connectCalendar ?? null,
    connectGmail: priorGiven?.connectGmail ?? null,
  };
  const spoken = await friendSpeak(
    deps,
    transcript,
    friendFields(
      friendStepForGap(onboardingMissing(checklist)[0], card),
      language,
      friendAddress(ctx),
      {
        introduce: opening && !transcriptHasOutbound(transcript),
        parentWords: inbound.body,
        placeLabel: place?.city || place?.areaCoarse || null,
        agesLabel: summarizeChildren(session.collected.children),
        ageMonths: session.collected.children.flatMap((child) =>
          child.ageMonths == null ? [] : [child.ageMonths],
        ),
        children: friendChildren(session.collected.children),
        parentName: priorGiven?.parentName ?? null,
        parentRole: priorGiven?.parentRole ?? null,
        checklist,
      },
    ),
    {
      pageScope: session.id,
      ...(opening ? { attemptTimeoutMs: OPENING_ATTEMPT_TIMEOUT_MS } : {}),
      // Place and an age provision this turn: the map and the name ask are the
      // reply, written next. This draft is read for its facts only.
      replyDiscardedWhen: (capture) => {
        const next = storedFromCapture(prior, capture);
        const nextPlace = next.place ? persistPlace(next.place) : null;
        const kids = withKnownAges(next.collectedChildren);
        return Boolean(kids && kids.length > 0 && nextPlace && intakeLocationFor(nextPlace));
      },
    },
  );
  language = spoken.capture.language ?? language;
  const stored = storedFromCapture(prior, spoken.capture);
  const nextPlace = stored.place ? persistPlace(stored.place) : null;
  const collected: IntakeCollected = {
    children: stored.collectedChildren,
    postalCode: stored.postalCode,
  };
  const given = givenFromStored(priorGiven, stored, spoken.capture);
  const children = withKnownAges(collected.children);
  const location = nextPlace ? intakeLocationFor(nextPlace) : null;
  const baseTouch: FirstTouchPersisted = {
    language,
    place: nextPlace,
    locationRequest,
    given,
    clarify: session.firstTouch?.clarify ?? null,
  };
  if (children && children.length > 0 && location && nextPlace) {
    if (opening) await reportOpening(deps, session, inbound, language);
    return provision(
      database,
      {
        session: { ...session, collected, ladderLanguage: language, firstTouch: baseTouch },
        phoneE164: args.phoneE164,
        inbound,
        now,
      },
      deps,
      { collected, children, location, transcript },
    );
  }
  const voiced = friendOutbound(spoken);
  if (!voiced && opening) {
    await saveSession(
      database,
      session,
      {
        state: 'awaiting_details',
        transcript,
        collected,
        lastProviderId: inbound.providerId,
        ladderLanguage: language,
        firstTouch: baseTouch,
      },
      now,
    );
    await reportOpening(deps, session, inbound, language);
    return { status: 'first_touch_unsent', reason: unsentReason(spoken) };
  }
  if (voiced) {
    ({ transcript } = await sendAndRecord(database, ctx, voiced, deps, transcript));
  }
  const waitingAges = nextPlace != null;
  const clarifyKey = waitingAges ? 'ages' : 'place';
  const priorCount = session.firstTouch?.clarify?.[clarifyKey] ?? 0;
  const partial = knownAgeChildren(collected.children);
  if (waitingAges && priorCount >= REASK_CAP && partial.length > 0 && location && nextPlace) {
    return provision(
      database,
      {
        session: {
          ...session,
          collected,
          ladderLanguage: language,
          firstTouch: touchWithClarify(baseTouch, 'ages'),
        },
        phoneE164: args.phoneE164,
        inbound,
        now,
      },
      deps,
      { collected, children: partial, location, transcript },
    );
  }
  const stuck =
    !opening &&
    ((session.state === 'awaiting_ages' && !agesKnown(collected.children)) ||
      (session.state !== 'awaiting_ages' && !nextPlace));
  await saveSession(
    database,
    session,
    {
      state: waitingAges ? 'awaiting_ages' : 'awaiting_place',
      transcript,
      collected,
      lastProviderId: inbound.providerId,
      ladderLanguage: language,
      firstTouch: stuck ? touchWithClarify(baseTouch, clarifyKey) : baseTouch,
    },
    now,
  );
  if (opening) await reportOpening(deps, session, inbound, language);
  if (waitingAges) {
    return { status: 'first_touch', step: opening ? 'find_sent' : 'ages_waiting' };
  }
  return { status: 'first_touch', step: opening ? 'place_asked' : 'place_waiting' };
}

async function continueFirstTouch(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  return friendOnboardingTurn(database, args, deps, false);
}

async function resolveFirstTouchLocation(
  ctx: SendContext,
  deps: IntakeDeps,
): Promise<{ accepted: boolean; locationRequest: FirstTouchPersisted['locationRequest'] }> {
  const at = ctx.now.toISOString();
  if (!firstTouchLocationCardEnabled()) {
    return { accepted: false, locationRequest: { at, outcome: 'skipped' } };
  }
  const chatId = ctx.pipe.chatId;
  const canRequest =
    ctx.pipe.channel === 'imessage' &&
    !ctx.pipe.isGroup &&
    typeof chatId === 'string' &&
    chatId.length > 0 &&
    typeof deps.transport.requestLocation === 'function';
  if (!canRequest || !chatId || !deps.transport.requestLocation) {
    return {
      accepted: false,
      locationRequest: { at, outcome: ctx.pipe.isGroup ? 'skipped_group' : 'not_a_moment' },
    };
  }
  try {
    const result = await deps.transport.requestLocation({ chatId });
    if (result.status === 'sent')
      return { accepted: true, locationRequest: { at, outcome: 'sent' } };
    if (result.status === 'refused') {
      console.info({ outcome: 'refused', code: result.code }, 'first-touch location card: refused');
      return { accepted: false, locationRequest: { at, outcome: 'refused', code: result.code } };
    }
    console.info({ outcome: result.status }, 'first-touch location card: not sent');
    return { accepted: false, locationRequest: { at, outcome: result.status } };
  } catch (err) {
    console.warn(
      { outcome: 'unreachable', err: err instanceof Error ? err.name : 'unknown' },
      'first-touch location card: unreachable',
    );
    return { accepted: false, locationRequest: { at, outcome: 'unreachable' } };
  }
}

function withColdStart(
  session: IntakeSession,
  language: ReplyLanguage | null,
  progress: ColdStartProgress,
): FirstTouchPersisted {
  return {
    ...(session.firstTouch ?? { language, place: null, locationRequest: null }),
    coldStart: progress,
  };
}

/**
 * Close a cold-start session without answering, so the inbound door can hand
 * this text to the coach. The message is not recorded here.
 */
async function closeColdStartForCoach(
  database: Database,
  session: IntakeSession,
  inbound: Inbound,
  now: Date,
): Promise<void> {
  await saveSession(
    database,
    session,
    { state: 'complete', closedAt: now, lastProviderId: inbound.providerId, ladderNext: null },
    now,
  );
}

/**
 * The first-hello Name and Photo share runs after the reply is sent, and only
 * when the transcript has no outbound yet. A timeout there (unreachable,
 * httpStatus 0) is retried once in that turn and, if it still fails, stored
 * on the session. The next turn tries again after its own reply, never before
 * it. {@link shareHaleContactCardOnce} claims
 * parent_channels.linq_contact_card_shared_at before it posts, and a share
 * already recorded for this chat today returns without a second POST. The audit row is
 * linq_contact_card_shared. A miss is logged and does not fail the reply.
 */
async function retryFailedLinqContactCard(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    now: Date;
    inbound: Inbound;
  },
): Promise<void> {
  try {
    await shareFreshLinqContactCard(database, args);
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'linq contact card: retry after a failed first share did not finish',
    );
  }
}

function childAgesChanged(
  prior: readonly { ageMonths: number | null }[],
  next: readonly { ageMonths: number | null }[],
): boolean {
  return next.some(
    (child, index) => child.ageMonths != null && child.ageMonths !== prior[index]?.ageMonths,
  );
}

function childNamesChanged(
  prior: readonly { name: string | null }[],
  next: readonly { name: string | null }[],
): boolean {
  return next.some((child, index) => {
    const name = child.name?.trim();
    if (!name) return false;
    return name !== prior[index]?.name;
  });
}

/** Onboarding never carries more children than this. The read is this family only. */
const ONBOARDING_CHILD_LIMIT = 24;

/** Write a corrected age or a newly given first name onto the child row. */
async function syncOnboardingChildren(
  database: Database,
  familyId: string,
  prior: readonly {
    name: string | null;
    ageMonths: number | null;
    agePrecision: 'years' | 'months' | null;
  }[],
  next: readonly {
    name: string | null;
    ageMonths: number | null;
    agePrecision: 'years' | 'months' | null;
  }[],
  now: Date,
): Promise<void> {
  const mine = await database
    .select({
      id: schema.children.id,
      familyId: schema.children.familyId,
      name: schema.children.name,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId))
    .orderBy(asc(schema.children.createdAt))
    .limit(ONBOARDING_CHILD_LIMIT);
  for (let index = 0; index < next.length; index++) {
    const child = next[index];
    const before = prior[index];
    if (!child) continue;
    const row =
      mine[index] ?? mine.find((candidate) => child.name != null && candidate.name === child.name);
    if (!row) continue;
    const patch: { name?: string; dateOfBirth?: string; dobPrecision?: string } = {};
    const first = kidFirstName(child.name);
    if (first && row.name !== first) patch.name = first;
    if (child.ageMonths != null && child.ageMonths !== before?.ageMonths) {
      patch.dateOfBirth = deriveDateOfBirth(child.ageMonths, child.agePrecision ?? 'years', now);
      patch.dobPrecision = 'derived';
    }
    if (patch.name == null && patch.dateOfBirth == null) continue;
    await database.update(schema.children).set(patch).where(eq(schema.children.id, row.id));
  }
}

/** A no or a later is stored on the session and on the audit log. The ledger update is best-effort. */
async function recordOnboardingChoices(
  database: Database,
  args: {
    familyId: string;
    userId: string;
    sessionId: string;
    prior: FirstTouchGiven | null;
    capture: {
      nameDeclined: boolean;
      kidsNamesDeclined: boolean;
      connectCalendar: boolean | null;
      connectGmail: boolean | null;
      calendarLater: boolean;
      gmailLater: boolean;
      scheduleDone?: boolean;
      scheduleAdds?: readonly unknown[];
      coparentGroup?: boolean | null;
    };
  },
): Promise<void> {
  const choices: { ask: string; choice: 'no' | 'later' }[] = [];
  if (
    args.capture.scheduleDone &&
    (args.capture.scheduleAdds ?? []).length === 0 &&
    (args.prior?.scheduled ?? []).length === 0 &&
    args.prior?.scheduleDone !== true
  ) {
    choices.push({ ask: 'schedule', choice: 'no' });
  }
  if (args.capture.coparentGroup === false && args.prior?.coparentGroup !== false) {
    choices.push({ ask: 'coparent', choice: 'no' });
  }
  if (args.capture.nameDeclined && args.prior?.nameDeclined !== true) {
    choices.push({ ask: 'names', choice: 'no' });
  }
  if (args.capture.kidsNamesDeclined && args.prior?.kidsNamesDeclined !== true) {
    choices.push({ ask: 'kids_names', choice: 'no' });
  }
  if (args.capture.connectCalendar === false && args.prior?.connectCalendar !== false) {
    choices.push({ ask: 'calendar', choice: 'no' });
  }
  if (args.capture.calendarLater && args.prior?.calendarLater !== true) {
    choices.push({ ask: 'calendar', choice: 'later' });
  }
  if (args.capture.connectGmail === false && args.prior?.connectGmail !== false) {
    choices.push({ ask: 'email', choice: 'no' });
  }
  if (args.capture.gmailLater && args.prior?.gmailLater !== true) {
    choices.push({ ask: 'email', choice: 'later' });
  }
  for (const choice of choices) {
    const declined = await declineOptionalAsk(database, {
      familyId: args.familyId,
      askKey: choice.ask,
    });
    if (!declined.updated) {
      console.info(
        { skipped: declined.skipped, ask: choice.ask },
        'onboarding: decline ledger not updated',
      );
    }
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'onboarding_ask_declined',
      targetTable: 'sms_intake_sessions',
      targetId: args.sessionId,
      after: choice,
    });
  }
}

/**
 * VIL-392 / VIL-417. The turn after the activity map. The model reads the
 * message, stores what it extracted, and writes the reply for the first item
 * still missing: the parent's name, Gmail, calendar, the schedule, then the
 * co-parent. A yes to Gmail or calendar sends that card and nothing else in
 * the same turn; the next ask waits for the receipt or the parent's next text.
 */
async function friendColdTurn(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { session, inbound, now } = args;
  let progress = session.firstTouch?.coldStart;
  const familyId = session.familyId;
  const userId = session.userId;
  if (!progress || !familyId || !userId) {
    await saveSession(
      database,
      session,
      { state: 'complete', closedAt: now, lastProviderId: inbound.providerId, ladderNext: null },
      now,
    );
    return { status: 'ignored', reason: 'no_open_conversation' };
  }
  const language = session.ladderLanguage ?? session.firstTouch?.language ?? null;
  const ctx = sendContext(args);
  const safety = await crisisReply(inbound, language, deps);
  if (safety) {
    const recorded = await recordInbound(database, ctx, inbound, session.transcript);
    if (safety.body) await sendAndRecord(database, ctx, safety.body, deps, recorded.transcript);
    await saveSession(database, session, { lastProviderId: inbound.providerId }, now);
    return { status: 'first_touch', step: 'find_sent' };
  }
  // The map never reached them. Retry it before any later ask. A miss sends
  // nothing and leaves the debt; the bubbles go out ahead of this turn's reply.
  let alreadyRecorded: {
    transcript: TranscriptEntry[];
    channelMessageId: string | null;
  } | null = null;
  if (progress.findDelivered === false) {
    const owed = await friendSpeak(
      deps,
      session.transcript,
      friendFields('find_show', language, friendAddress(ctx), {
        parentWords: inbound.body,
        placeLabel:
          session.firstTouch?.place?.city || session.firstTouch?.place?.areaCoarse || null,
        agesLabel: summarizeChildren(session.collected.children),
        ageMonths: session.collected.children.flatMap((child) =>
          child.ageMonths == null ? [] : [child.ageMonths],
        ),
        children: friendChildren(session.collected.children),
        findLines: linesOfFind(progress.findBody),
        findGroups: groupsFromFindBody(progress.findBody),
        listKind: 'none',
        parentName: session.firstTouch?.given?.parentName ?? null,
        now,
      }),
      { pageScope: familyId },
    );
    if (owed.source === 'unsent') {
      await recordInbound(database, ctx, inbound, session.transcript);
      await saveSession(database, session, { lastProviderId: inbound.providerId }, now);
      return { status: 'first_touch_unsent', reason: unsentReason(owed) };
    }
    const bubbles = owed.bubbles.filter((bubble) => bubble.trim().length > 0);
    if (bubbles.length === 0) {
      await recordInbound(database, ctx, inbound, session.transcript);
      await saveSession(database, session, { lastProviderId: inbound.providerId }, now);
      return { status: 'first_touch_unsent', reason: 'unusable' };
    }
    // Deliver the map before any reply-dependent write. A send that does not
    // land leaves the debt and creates no reminders.
    const recordedMap = await recordInbound(database, ctx, inbound, session.transcript);
    let delivered = false;
    for (const bubble of bubbles) {
      const sentMap = await sendAndRecord(database, ctx, bubble, deps, recordedMap.transcript);
      if (!sentMap.channelMessageId) {
        delivered = false;
        break;
      }
      delivered = true;
    }
    if (!delivered) {
      await saveSession(database, session, { lastProviderId: inbound.providerId }, now);
      return { status: 'first_touch_unsent', reason: 'unusable' };
    }
    alreadyRecorded = recordedMap;
    progress = { ...progress, findDelivered: true };
  }
  const lines = linesOfFind(progress.findBody);
  const needsName = await parentNeedsName(database, userId);
  const given = session.firstTouch?.given ?? null;
  const checklist: OnboardingChecklist = {
    postal: session.firstTouch?.place != null,
    kids: kidsKnown(session.collected.children, given),
    ages: agesKnown(session.collected.children),
    name: nameKnown(given, needsName),
    gmail: gmailAnswered(given),
    calendar: calendarAnswered(given),
    schedule: scheduleKnown(given, lines.length),
    coparent: coparentKnown(given),
  };
  const gap = onboardingMissing(checklist)[0];
  const step = friendStepForGap(gap, false);
  const join = gap === 'schedule' || gap === 'coparent' ? coparentJoinFor(ctx, language) : null;
  const spoken = await friendSpeak(
    deps,
    session.transcript,
    friendFields(step, language, friendAddress(ctx), {
      parentWords: inbound.body,
      placeLabel: session.firstTouch?.place?.city || session.firstTouch?.place?.areaCoarse || null,
      agesLabel: summarizeChildren(session.collected.children),
      ageMonths: session.collected.children.flatMap((child) =>
        child.ageMonths == null ? [] : [child.ageMonths],
      ),
      children: friendChildren(session.collected.children),
      findLines: lines,
      findGroups: groupsFromFindBody(progress.findBody),
      listKind: 'none',
      activity: progress.activity,
      day: progress.day,
      parentName: given?.parentName ?? null,
      parentRole: given?.parentRole ?? null,
      now,
      scheduled: scheduledForModel(given, language),
      coparentJoin: join,
      checklist,
    }),
    {
      // A card rides only the ask for its own connector, and only the first time.
      linkFollows: (judged) =>
        (judged === 'email' && !progress.emailOffered) ||
        (judged === 'calendar' && !progress.calendarOffered),
      linkAbove:
        (gap === 'gmail' && progress.emailOffered === true) ||
        (gap === 'calendar' && progress.calendarOffered === true),
      pageScope: familyId,
    },
  );
  if (spoken.capture.stopAsking) {
    const recorded =
      alreadyRecorded ?? (await recordInbound(database, ctx, inbound, session.transcript));
    const voiced = friendOutbound(spoken);
    if (voiced) await sendAndRecord(database, ctx, voiced, deps, recorded.transcript);
    await saveSession(
      database,
      session,
      { state: 'complete', closedAt: now, lastProviderId: inbound.providerId, ladderNext: null },
      now,
    );
    return { status: 'first_touch', step: 'place_waiting' };
  }
  const stored = storedFromCapture(
    {
      children: session.collected.children,
      postalCode: session.collected.postalCode,
      place: null,
      parentName: given?.parentName ?? null,
      parentRole: given?.parentRole ?? null,
      connectCalendar: given?.connectCalendar ?? null,
      connectGmail: given?.connectGmail ?? null,
    },
    spoken.capture,
  );
  const mergedChildren = stored.collectedChildren;
  const agesChanged = childAgesChanged(session.collected.children, mergedChildren);
  if (agesChanged || childNamesChanged(session.collected.children, mergedChildren)) {
    await syncOnboardingChildren(
      database,
      familyId,
      session.collected.children,
      mergedChildren,
      now,
    );
  }
  if (agesChanged) {
    const corrected = mergedChildren.find(
      (child, index) =>
        child.ageMonths != null && child.ageMonths !== session.collected.children[index]?.ageMonths,
    );
    if (corrected?.ageMonths != null) {
      await writeFact(
        database,
        ageCorrectionFact({ familyId, childId: null, ageMonths: corrected.ageMonths, now }),
      );
    }
  }
  // stored.parentName has already dropped a kid's name read as the parent's.
  if (stored.parentName && stored.parentName !== given?.parentName) {
    await storeModelParentName(database, {
      familyId,
      parentUserId: userId,
      name: stored.parentName,
    });
  }
  await keepParentRole(database, { familyId, userId, guess: stored.parentRole });
  // A reminder is written only when the reply that confirms it goes out.
  const written =
    lines.length > 0 && spoken.capture.scheduleAdds.length > 0 && friendOutbound(spoken)
      ? await writeScheduleAdds(database, {
          familyId,
          userId,
          sessionId: session.id,
          adds: spoken.capture.scheduleAdds,
          lines,
          already: given?.scheduled ?? [],
        })
      : { scheduled: [], eventIds: [] };
  const nextGiven = givenFromStored(given, stored, spoken.capture, {
    scheduled: written.scheduled,
  });
  await recordOnboardingChoices(database, {
    familyId,
    userId,
    sessionId: session.id,
    prior: given,
    capture: spoken.capture,
  });
  const parentIsKnown = nameKnown(nextGiven, needsName);
  const everyLineScheduled =
    lines.length > 0 &&
    lines.every((_line, index) =>
      (nextGiven?.scheduled ?? []).some((row) => row.line === index + 1),
    );
  const after: OnboardingChecklist = {
    postal: checklist.postal,
    kids: kidsKnown(mergedChildren, nextGiven),
    ages: agesAreComplete(mergedChildren),
    name: parentIsKnown,
    gmail: gmailAnswered(nextGiven),
    calendar: calendarAnswered(nextGiven),
    schedule: scheduleKnown(nextGiven, lines.length) || everyLineScheduled,
    coparent: coparentKnown(nextGiven),
  };
  const next = onboardingMissing(after)[0];
  const nextProgress: ColdStartProgress = {
    ...progress,
    step: next === 'name' || next === 'kids' ? 'names' : 'follow',
    nameLineSent: parentIsKnown || next === 'name' || next === 'kids' || next == null,
    calendarAsked: after.calendar,
    emailAsked: after.gmail,
  };
  const recorded =
    alreadyRecorded ?? (await recordInbound(database, ctx, inbound, session.transcript));
  let voiced = friendOutbound(spoken);
  await pursueNewHouseholdGroup(
    database,
    {
      mode: spoken.capture.coparentGroupMode,
      familyId,
      parentUserId: userId,
      parentPhoneE164: session.phoneE164,
      now,
      inboundBody: inbound.body,
      ask: deps.consentAsk,
    },
    async (body) => {
      await sendAndRecord(database, ctx, body, deps, recorded.transcript);
    },
  );
  if (!voiced) {
    await saveSession(
      database,
      session,
      {
        lastProviderId: inbound.providerId,
        collected: { ...session.collected, children: mergedChildren },
        firstTouch: { ...withColdStart(session, language, nextProgress), given: nextGiven },
      },
      now,
    );
    return { status: 'first_touch', step: 'find_sent' };
  }
  // Flag off: the number and phrase go under a yes. Flag on: the number alone, and
  // only when the model read an existing iMessage group. Never under the ask.
  const trailer = coparentTrailer(join, spoken.capture.coparentGroupMode);
  if (trailer && spoken.capture.coparentGroup === true) {
    voiced = `${voiced}\n${trailer}`;
  }
  // A card rides this reply only when the reply is about that connector: a
  // yes whose card has not gone out yet, or the ask itself. A reply written
  // for another step (the name, the schedule) carries no link.
  const askCard =
    spoken.step === 'email' && next === 'gmail' && !progress.emailOffered
      ? 'gmail'
      : spoken.step === 'calendar' && next === 'calendar' && !progress.calendarOffered
        ? 'gcal'
        : null;
  const pending = pendingConnector(nextGiven, progress) ?? askCard;
  if (pending) {
    const provider = pending;
    const ask = provider === 'gmail' ? 'email' : 'calendar';
    const gate = await gateOptionalAsk(database, {
      familyId,
      now,
      sendClass: ask,
      askKey: ask,
    });
    let carried = false;
    if (gate.allow) {
      const cards = await sendYearConnectorCards(
        database,
        {
          familyId,
          parentUserId: userId,
          phoneE164: session.phoneE164,
          language,
          now,
          ridesReply: true,
          only: provider,
          voice: { [provider]: spoken.prose },
        },
        { transport: deps.transport, threadMessage: deps.threadMessage },
      );
      const label = provider === 'gcal' ? cards.calendar : cards.gmail;
      if (label === 'sent') {
        await recordOptionalAsk(database, { familyId, now, sendClass: ask, askKey: ask });
        if (provider === 'gcal') nextProgress.calendarOffered = true;
        else nextProgress.emailOffered = true;
        carried = true;
      }
    } else {
      console.info({ reason: gate.reason, ask }, 'onboarding-friend: connector held');
    }
    if (!carried) await sendAndRecord(database, ctx, voiced, deps, recorded.transcript);
  } else {
    await sendAndRecord(database, ctx, voiced, deps, recorded.transcript);
  }
  // A connector card is its own turn. The next ask rides the receipt or the next text.
  const complete = next == null && !pending;
  await saveSession(
    database,
    session,
    {
      lastProviderId: inbound.providerId,
      collected: { ...session.collected, children: mergedChildren },
      transcript: threadForNext(
        session.transcript,
        inbound.body,
        inbound.receivedAt.toISOString(),
        voiced,
        now,
      ),
      firstTouch: { ...withColdStart(session, language, nextProgress), given: nextGiven },
      ...(complete ? { state: 'complete' as const, closedAt: now, ladderNext: null } : {}),
    },
    now,
  );
  return { status: 'first_touch', step: 'find_sent' };
}

/**
 * A yes to Gmail or the calendar whose card has not gone out yet. Gmail first:
 * the calendar card follows the Gmail receipt (connected-notice.ts).
 */
function pendingConnector(
  given: FirstTouchGiven | null,
  progress: Pick<ColdStartProgress, 'emailOffered' | 'calendarOffered'> | null,
): 'gmail' | 'gcal' | null {
  if (given?.connectGmail === true && !progress?.emailOffered) return 'gmail';
  if (given?.connectCalendar === true && !progress?.calendarOffered) return 'gcal';
  return null;
}

async function continueColdStart(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const outcome = await runColdStartTurn(database, args, deps);
  const familyId = args.session.familyId;
  const userId = args.session.userId;
  if (familyId && userId && args.session.firstTouch?.coldStart) {
    await finishCardWithinReplyBudget(
      retryFailedLinqContactCard(database, {
        familyId,
        parentUserId: userId,
        now: args.now,
        inbound: args.inbound,
      }),
    );
  }
  return outcome;
}

async function runColdStartTurn(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { session, inbound, now } = args;
  const progress = session.firstTouch?.coldStart;
  const familyId = session.familyId;
  const userId = session.userId;
  if (!progress || !familyId || !userId) {
    await saveSession(
      database,
      session,
      { state: 'complete', closedAt: now, lastProviderId: inbound.providerId, ladderNext: null },
      now,
    );
    return { status: 'ignored', reason: 'no_open_conversation' };
  }
  // An owed map is not a legacy pick question. The six-hour pick expiry must
  // not close the session before the map is retried.
  if (
    progress.findDelivered !== false &&
    coldStartQuestionIsStale(progress.step, lastTranscriptAt(session.transcript), now)
  ) {
    console.info(
      { stale: 'cold_start' },
      'cold-start: question is stale, handing the text to the coach',
    );
    await closeColdStartForCoach(database, session, inbound, now);
    return { status: 'ignored', reason: 'no_open_conversation' };
  }
  return friendColdTurn(database, args, deps);
}

function persistPlace(place: FirstTouchPlace): NonNullable<FirstTouchPersisted['place']> {
  return {
    kind: place.kind,
    areaCoarse: place.areaCoarse,
    postalCode: place.postalCode,
    municipality: place.municipality,
    city: place.city,
  };
}

function intakeLocationFor(
  place: NonNullable<FirstTouchPersisted['place']> | FirstTouchPlace,
): IntakeLocation | null {
  if (place.kind !== 'postal') return null;
  return parseIntakePostal(place.postalCode ?? place.areaCoarse);
}

async function handleDetails(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  // With the friend voice and the first-touch walk both on, a pre-family session
  // is one conversation whatever state it was left in: the model reads the text
  // and writes the next ask. No unreadable door, no fixed region line.
  return friendOnboardingTurn(
    database,
    args,
    deps,
    !transcriptHasOutbound(args.session.transcript),
  );
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

/** Children whose age was actually told. Siblings still missing an age are left out. */
function knownAgeChildren(children: readonly ExtractedChild[]): ProvisionChild[] {
  const known: ProvisionChild[] = [];
  for (const child of children) {
    if (child.ageMonths === null || child.agePrecision === null) continue;
    known.push({ name: child.name, ageMonths: child.ageMonths, agePrecision: child.agePrecision });
  }
  return known;
}

/**
 * After an outbound on a 1:1 iMessage chat, share Hale's Name and Photo card
 * once per Toronto day for that chat. Linq will not show the card before that
 * outbound. A second bubble in this turn, SMS, and groups do not share. A
 * failure here is logged and does not fail the send that already landed.
 *
 * Before a family exists the claim is the session marker provisioning copies
 * onto parent_channels. After that, the channel row plus the audit chat id
 * are the day's claim.
 */
async function shareLinqCardAfterFirstOutbound(
  database: Database,
  ctx: SendContext,
  sent: { channel: string; chatId: string | null },
): Promise<void> {
  try {
    const chatId = sent.chatId;
    const claim = ctx.session.linqContactCardClaim;
    if (!chatId || sent.channel !== 'imessage' || ctx.pipe.isGroup) return;
    if (linqCardStarted.has(ctx.session)) return;
    if (linqContactCardShareBlocked(claim, chatId, ctx.now)) return;
    linqCardStarted.add(ctx.session);
    const sameDay =
      claim?.at != null && haleContactCardDay(new Date(claim.at)) === haleContactCardDay(ctx.now);

    if (ctx.session.familyId && ctx.session.userId) {
      const shared = await shareHaleContactCardOnce(database, {
        familyId: ctx.session.familyId,
        parentUserId: ctx.session.userId,
        chatId,
        channel: 'imessage',
        isGroup: false,
        now: ctx.now,
      });
      if (
        shared.status === 'shared' ||
        (shared.status === 'not_sent' && shared.reason === 'already_shared')
      ) {
        ctx.session.linqContactCardClaim = {
          at: ctx.now.toISOString(),
          outcome: 'shared',
          chatId,
        };
      } else if (shared.status === 'not_sent' && shared.reason === 'share_refused') {
        ctx.session.linqContactCardClaim = {
          at: ctx.now.toISOString(),
          outcome: 'share_refused',
          chatId,
          code: shared.code,
        };
      } else if (shared.status === 'not_sent' && shared.reason === 'unreachable') {
        const attempts =
          (sameDay && claim?.outcome === 'unreachable' ? (claim.attempts ?? 1) : 0) + 1;
        ctx.session.linqContactCardClaim = {
          at: ctx.now.toISOString(),
          outcome: 'unreachable',
          chatId,
          code: 'unreachable',
          attempts,
        };
      }
      return;
    }

    const delivered = await deliverHaleLinqContactCard({
      chatId,
      familyId: null,
    });
    if (delivered.outcome.status === 'shared') {
      ctx.session.linqContactCardClaim = {
        at: ctx.now.toISOString(),
        outcome: 'shared',
        chatId,
      };
      return;
    }
    if (delivered.outcome.status === 'not_sent' && delivered.outcome.reason === 'share_refused') {
      ctx.session.linqContactCardClaim = {
        at: ctx.now.toISOString(),
        outcome: 'share_refused',
        chatId,
        code: delivered.outcome.code,
      };
      return;
    }
    if (delivered.outcome.status === 'not_sent' && delivered.outcome.reason === 'unreachable') {
      const attempts =
        (sameDay && claim?.outcome === 'unreachable' ? (claim.attempts ?? 1) : 0) + 1;
      ctx.session.linqContactCardClaim = {
        at: ctx.now.toISOString(),
        outcome: 'unreachable',
        chatId,
        code: 'unreachable',
        attempts,
      };
    }
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'linq contact card: outbound share did not finish',
    );
  }
}

/**
 * Retry the Linq Name and Photo share when today's claim is open. Silent
 * either way: a share already recorded for this chat today returns without a
 * second POST and without a chat line. SMS and groups are not this moment.
 * The next Toronto day's first outbound shares again.
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
      now: args.now,
    });
    return shared.status === 'shared' ? 'shown' : 'silent';
  }
  return 'silent';
}

/**
 * The beats that used to wait for "cool". Same turn, in order: the year find
 * (already sent, its own bubble), then the name ask. French skips the English
 * name and sends the calendar card instead.
 *
 * The Linq card is not a bubble. It shares after an outbound, once per
 * Toronto day per chat. This ladder calls the share again only so a released
 * claim can still land today. A card already shared today is skipped.
 * Nothing here apologises or adds a line.
 */
async function sendPostYearFindLadder(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    phoneE164: string;
    language: ReplyLanguage | null;
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
  const pipe = messagingPipe(args.inbound);
  const asked = await askParentCallName(database, {
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    language: args.language,
    send: args.send,
    friend: {
      deps,
      transcript: [],
      parentWords: args.inbound.body,
      address: pipe.isGroup ? 'vous' : 'tu',
    },
  });
  // No voice, no fixed line: the ask is skipped and the ladder moves on.
  return asked ? 'name_reply' : 'gmail';
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

  const language = session.ladderLanguage ?? null;
  const discoveryOn = coldStartLadderEnabled() && session.firstTouch != null;
  const children = discoveryOn
    ? gathered.children.map((child) => ({ ...child, name: kidFirstName(child.name) }))
    : gathered.children;
  const { familyId, userId } = await provisionFromIntake(database, {
    phoneE164,
    phoneHash: session.phoneHash,
    children,
    location: gathered.location,
    sourceCode: session.sourceCode,
    firstMessage: firstInbound?.body ?? inbound.body,
    transcript: gathered.transcript,
    now,
    language,
    linqContactCardClaim: session.linqContactCardClaim,
  });

  const locationRequest = session.firstTouch?.locationRequest;
  if (locationRequest) {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'first_touch_location_requested',
      targetTable: 'sms_intake_sessions',
      targetId: session.id,
      after: {
        outcome: locationRequest.outcome,
        ...(locationRequest.code ? { code: locationRequest.code } : {}),
      },
    });
  }

  // From here the session HAS a family, so messages go straight to channel_messages —
  // the transcript it carried has just been replayed there.
  const provisioned: IntakeSession = { ...session, familyId, userId };
  const ctx = sendContext({ session: provisioned, phoneE164, inbound, now });

  deps.keepTyping?.();
  const radar = await deps.radar.compose({
    familyId,
    children: gathered.collected.children,
    areaCoarse: gathered.location.areaCoarse,
    language,
    ...(discoveryOn ? { activityMap: true } : {}),
  });
  const placeLabel =
    session.firstTouch?.place?.city ||
    session.firstTouch?.place?.areaCoarse ||
    gathered.location.areaCoarse;
  const findLines = linesOfFind(radar.message);
  let outboundBody = radar.message;
  let outboundKey: string | undefined = radar.weekendPickOffered
    ? INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY
    : undefined;
  let friendCold: ColdStartProgress | null = null;
  let connectorSent = false;
  {
    const given = session.firstTouch?.given ?? null;
    if (given?.parentName) {
      await storeModelParentName(database, {
        familyId,
        parentUserId: userId,
        name: given.parentName,
      });
    }
    await keepParentRole(database, { familyId, userId, guess: given?.parentRole });
    const empty = findLines.length === 0;
    const nameKnown = Boolean(given?.parentName) || given?.nameDeclined === true;
    const checklist: OnboardingChecklist = {
      postal: true,
      kids: kidsKnown(gathered.collected.children, given),
      ages: true,
      name: nameKnown,
      gmail: gmailAnswered(given),
      calendar: calendarAnswered(given),
      schedule: empty,
      coparent: false,
    };
    const gap = onboardingMissing(checklist)[0];
    const common = {
      placeLabel,
      agesLabel: summarizeChildren(gathered.collected.children),
      ageMonths: children.map((child) => child.ageMonths),
      children: friendChildren(children),
      parentName: given?.parentName ?? null,
      parentRole: given?.parentRole ?? null,
      checklist,
      now,
    };
    // Step 4: the map, as two or three bubbles with no question, then the next
    // ask as its own message. Both are written at once so this turn costs one
    // model round-trip, not two; the sends stay in order.
    const thread = gathered.transcript;
    const step: FriendStep =
      gap === 'name' && empty && discoveryOn ? 'find_empty' : friendStepForGap(gap, false);
    const groups = (
      radar.groups && radar.groups.length > 0
        ? radar.groups
        : [{ category: 'learning_sports_arts', lines: findLines }]
    ).map((group) => ({ category: group.category, lines: [...group.lines] }));
    const [map, spoken] = await Promise.all([
      discoveryOn && !empty
        ? friendSpeak(
            deps,
            thread,
            friendFields('find_show', language, friendAddress(ctx), {
              ...common,
              parentWords: inbound.body,
              findLines,
              findGroups: groups,
            }),
            { pageScope: familyId },
          )
        : Promise.resolve(null),
      friendSpeak(
        deps,
        thread,
        friendFields(step, language, friendAddress(ctx), {
          ...common,
          introduce: !discoveryOn && step === 'names',
          parentWords: inbound.body,
          findLines,
          listKind: 'none',
        }),
        {
          linkFollows: (judged) => judged === 'email' || judged === 'calendar',
          pageScope: familyId,
        },
      ),
    ]);
    const mapUnsent = map?.source === 'unsent';
    if (map && !mapUnsent) {
      let delivered = false;
      for (const bubble of map.bubbles) {
        if (bubble.trim().length === 0) continue;
        const sentMap = await sendAndRecord(database, ctx, bubble, deps, []);
        if (!sentMap.channelMessageId) {
          delivered = false;
          break;
        }
        delivered = true;
        deps.keepTyping?.();
      }
      const offered = (radar.groups?.flatMap((group) => group.picks ?? []) ?? []).map(
        withSourceUrl,
      );
      if (delivered && offered.length) await recordActivityOffers(database, familyId, offered, now);
    }
    outboundBody = mapUnsent ? '' : (friendOutbound(spoken) ?? '');
    if (discoveryOn && (step === 'find_empty' || step === 'names')) {
      outboundKey = PARENT_NAME_ASK_TEMPLATE_KEY;
    }
    if (!discoveryOn) outboundKey = PARENT_NAME_ASK_TEMPLATE_KEY;
    const cardStep = spoken.step;
    if ((cardStep === 'calendar' || cardStep === 'email') && outboundBody) {
      const provider = cardStep === 'calendar' ? 'gcal' : 'gmail';
      await sendYearConnectorCards(
        database,
        {
          familyId,
          parentUserId: userId,
          phoneE164,
          language,
          now,
          ridesReply: true,
          only: provider,
          voice: { [provider]: spoken.prose },
        },
        { transport: deps.transport, threadMessage: deps.threadMessage },
      );
      connectorSent = true;
    }
    if (discoveryOn) {
      friendCold = {
        step: step === 'names' || step === 'find_empty' || mapUnsent ? 'names' : 'follow',
        group: ctx.pipe.isGroup,
        findBody: radar.message,
        activity: null,
        day: null,
        nameLineSent: !mapUnsent,
        ...(mapUnsent ? { findDelivered: false } : {}),
        signupDateKnown: false,
        signupAsked: false,
        calendarAsked: calendarAnswered(given),
        emailAsked: gmailAnswered(given),
        ...(connectorSent && cardStep === 'calendar' ? { calendarOffered: true } : {}),
        ...(connectorSent && cardStep === 'email' ? { emailOffered: true } : {}),
        schoolMentioned: false,
      };
    }
  }
  const sent =
    connectorSent || outboundBody.trim().length === 0
      ? { transcript: [] as TranscriptEntry[], channelMessageId: null }
      : await sendAndRecord(database, ctx, outboundBody, deps, [], outboundKey);

  // The find is its own bubble. A year-find with two or more titles, on the
  // Linq thread that just carried it, may ask which to look at first. That
  // poll is the one ask of this turn: the name (English) or the calendar card
  // (French) waits for the next inbound. Fewer than two titles, a flag that
  // is not exactly on, SMS, or a send that never asked — the ladder ask goes
  // out now, as before. The Linq card is not an ask.
  //
  // VIL-392 discovery session one stops here: receipt plus the find, then
  // silence. No name, calendar, gmail, co-parent, poll, or contact card.
  let ladderNext: IntakeLadderStep | null = null;
  // Friend voice makes the year bubble the name ask. A second ladder bubble
  // would be a second question in the same turn.
  if (!discoveryOn) {
    await shareFreshLinqContactCard(database, {
      familyId,
      parentUserId: userId,
      now,
      inbound,
    });
    ladderNext = 'name_reply';
  }

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
      summary: FIRST_FIND_BEAT,
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
    defaultFounderPingPorts(deps.transport, deps.consentAsk),
  );

  await saveSession(
    database,
    session,
    {
      collected: gathered.collected,
      transcript: [
        ...gathered.transcript,
        {
          direction: 'out' as const,
          body: outboundBody,
          providerId: null,
          at: now.toISOString(),
        },
      ],
      state: discoveryOn ? 'awaiting_cold_start' : 'awaiting_ladder',
      familyId,
      userId,
      lastProviderId: inbound.providerId,
      findWon: radar.findWon,
      ladderNext: discoveryOn ? null : ladderNext,
      ladderLanguage: language,
      ...(discoveryOn && session.firstTouch
        ? {
            firstTouch: {
              ...session.firstTouch,
              coldStart: friendCold ?? {
                step: 'pick',
                group: ctx.pipe.isGroup,
                findBody: radar.message,
                activity: null,
                day: null,
                nameLineSent: false,
                signupDateKnown: false,
                signupAsked: false,
                calendarAsked: false,
                emailAsked: false,
                schoolMentioned: false,
              },
            },
          }
        : {}),
    },
    now,
  );
  // `source_code` is null when nobody handed out a card, and it stays ABSENT rather than
  // becoming a string like 'direct': buildEvent drops a null, and a bucket meaning "no
  // card" must not be able to look like a card that exists.
  await reportIntakeStep(deps, 'intake_completed', session.id, {
    source_code: session.sourceCode,
    ...intakeShape(gathered.transcript, now),
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
 * later. Discovery is a model call plus geocodes, far past a Linq webhook's budget,
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
async function handleWatchReply(
  database: Database,
  args: { session: IntakeSession; phoneE164: string; inbound: Inbound; now: Date },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { session, inbound, now } = args;
  const ctx = sendContext(args);
  const recorded = await recordInbound(database, ctx, inbound, session.transcript);
  const language = session.ladderLanguage ?? session.firstTouch?.language ?? null;

  // The watch offer is retired under the friend voice: the find is the watch.
  // A session left waiting on it still gets an answer, written by the model,
  // and is closed so the next text reaches the family's own thread.
  const safety = await crisisReply(inbound, language, deps);
  const body = safety ? safety.body : await helpBody(deps, session, language, inbound.body);
  if (body) await sendAndRecord(database, ctx, body, deps, recorded.transcript);
  await saveSession(
    database,
    session,
    { state: 'complete', closedAt: now, lastProviderId: inbound.providerId },
    now,
  );
  return { status: 'question_answered', source: safety ? 'safety' : 'composed' };
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

  const language = session.ladderLanguage ?? null;
  const ctx = sendContext(args);
  const recorded = await recordInbound(database, ctx, inbound, session.transcript);

  const crisis = await crisisReply(inbound, language, deps);
  if (crisis) {
    if (crisis.body) await sendAndRecord(database, ctx, crisis.body, deps, recorded.transcript);
    await saveSession(database, session, { lastProviderId: inbound.providerId }, now);
    return { status: 'question_answered', source: 'safety' };
  }

  let next: IntakeLadderStep | null = step;
  let closed = false;
  let heldForQuestion = false;

  // A question right after the find is answered first; the model decides whether
  // the parent's words are a question (offScriptReply returns null when not).
  const openOffScript = step === 'turtle' || step === 'name_reply';
  if (openOffScript) {
    const offScript = await offScriptReply(
      {
        parentWords: inbound.body,
        pendingAsk: '',
        children: session.collected.children,
        postalCode: session.collected.postalCode,
        language,
      },
      deps,
    );
    if (offScript) {
      if (offScript.body) {
        await sendAndRecord(database, ctx, offScript.body, deps, recorded.transcript);
      }
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
      friend: {
        deps,
        transcript: recorded.transcript,
        parentWords: inbound.body,
        address: friendAddress(ctx),
      },
    });
    next = asked ? 'name_reply' : 'gmail';
  } else if (step === 'name_reply') {
    // The model reads the name (or a yes to the Google name) and writes the
    // Gmail ask in the same turn. Gmail first: the calendar card rides its receipt.
    const card = await sendLadderFriendCard(database, ctx, deps, {
      familyId,
      parentUserId: userId,
      phoneE164,
      language,
      now,
      inbound,
      transcript: recorded.transcript,
      provider: 'gmail',
      nameReply: true,
    });
    next = card.next;
  } else if (step === 'calendar' || step === 'gmail') {
    const card = await sendLadderFriendCard(database, ctx, deps, {
      familyId,
      parentUserId: userId,
      phoneE164,
      language,
      now,
      inbound,
      transcript: recorded.transcript,
      provider: step === 'calendar' ? 'gcal' : 'gmail',
    });
    next = card.next;
  } else {
    const join = coparentJoinFor(ctx, language);
    const spoken = await friendSpeak(
      deps,
      recorded.transcript,
      friendFields('coparent', language, friendAddress(ctx), {
        parentWords: inbound.body,
        coparentJoin: join,
      }),
      { trailer: coparentTrailer(join, null) },
    );
    const voiced = friendOutbound(spoken);
    if (voiced) {
      await sendAndRecord(
        database,
        ctx,
        voiced,
        deps,
        recorded.transcript,
        INTAKE_COPARENT_ASK_TEMPLATE_KEY,
      );
    }
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
 * The locked call-name line, its own bubble, in the same turn as the year find
 * and after the turtle card when that card shared.
 *
 * "What should I call you?" when there is no safe Google given name, and
 * "Can I call you {first}?" when there is. The composer is not called. A French
 * reply skips the English line. A parent who already has a name, or who was
 * already asked, is not asked again. A lookup that throws is logged and does
 * not hold the inbox or co-parent asks (rule #11).
 */
async function sendLadderFriendCard(
  database: Database,
  ctx: SendContext,
  deps: IntakeDeps,
  args: {
    familyId: string;
    parentUserId: string;
    phoneE164: string;
    language: ReplyLanguage | null;
    now: Date;
    inbound: Inbound;
    transcript: TranscriptEntry[];
    provider: 'gcal' | 'gmail';
    /** The text being answered is the reply to the name ask. Store what the model read. */
    nameReply?: boolean;
  },
): Promise<{ next: IntakeLadderStep }> {
  const step: FriendStep = args.provider === 'gcal' ? 'calendar' : 'email';
  const held = args.nameReply
    ? await loadParentCallName(database, {
        familyId: args.familyId,
        parentUserId: args.parentUserId,
      })
    : null;
  const spoken = await friendSpeak(
    deps,
    args.transcript,
    friendFields(step, args.language, friendAddress(ctx), {
      parentWords: args.inbound.body,
      parentName: held ? safeGivenName(held.googleGivenName) : null,
    }),
    { linkFollows: true },
  );
  if (args.nameReply) {
    const heldName = held ? safeGivenName(held.googleGivenName) : null;
    await keepLadderName(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      capture: applyNameControl(args.inbound.body, spoken.capture, heldName),
      heldGivenName: heldName,
    });
  }
  if (!friendOutbound(spoken)) {
    return { next: args.provider === 'gcal' ? 'calendar' : 'gmail' };
  }
  const cards = await sendYearConnectorCards(
    database,
    {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      phoneE164: args.phoneE164,
      language: args.language,
      now: args.now,
      ridesReply: true,
      only: args.provider,
      voice: { [args.provider]: spoken.prose },
    },
    { transport: deps.transport, threadMessage: deps.threadMessage },
  );
  const label = args.provider === 'gcal' ? cards.calendar : cards.gmail;
  if (label === 'sent' || label === 'already_sent') {
    return { next: args.provider === 'gmail' ? 'calendar' : 'coparent' };
  }
  const retry = await friendSpeak(
    deps,
    args.transcript,
    friendFields('link_retry', args.language, friendAddress(ctx), {
      parentWords: args.inbound.body,
    }),
  );
  const retried = friendOutbound(retry);
  if (retried) {
    await sendAndRecord(database, ctx, retried, deps, args.transcript);
  }
  return { next: args.provider === 'gcal' ? 'calendar' : 'gmail' };
}

async function askParentCallName(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    language: ReplyLanguage | null;
    send: (body: string, templateKey: string) => Promise<unknown>;
    friend?: {
      deps: IntakeDeps;
      transcript: TranscriptEntry[];
      parentWords: string;
      address: 'tu' | 'vous';
    };
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
      async (decision) => {
        const friend = args.friend;
        if (!friend) {
          console.info({ ask: decision.kind }, 'intake: name ask has no voice; not sent');
          return false;
        }
        const spoken = await friendSpeak(
          friend.deps,
          friend.transcript,
          friendFields(
            decision.kind === 'confirm' ? 'name_confirm' : 'names',
            args.language,
            friend.address,
            {
              parentWords: friend.parentWords,
              parentName: decision.kind === 'confirm' ? decision.first : null,
            },
          ),
        );
        const voiced = friendOutbound(spoken);
        if (!voiced) return false;
        await args.send(voiced, decision.templateKey);
        return true;
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

/** HELP is model-written when friend voice is on. STOP and the safety lines stay locked. */
async function helpBody(
  deps: IntakeDeps,
  session: IntakeSession | null,
  language: ReplyLanguage | null,
  parentWords: string,
): Promise<string | null> {
  const given = session?.firstTouch?.given ?? null;
  const children = session?.collected.children ?? [];
  const checklist: OnboardingChecklist = {
    postal: session?.firstTouch?.place != null,
    kids: kidsKnown(children, given),
    ages: agesKnown(children),
    name: Boolean(given?.parentName) || given?.nameDeclined === true,
    gmail: gmailAnswered(given),
    calendar: calendarAnswered(given),
    schedule: scheduleKnown(
      given,
      linesOfFind(session?.firstTouch?.coldStart?.findBody ?? '').length,
    ),
    coparent: coparentKnown(given),
  };
  const spoken = await friendSpeak(
    deps,
    session?.transcript ?? [],
    friendFields('help', language, 'tu', {
      parentWords,
      placeLabel:
        session?.firstTouch?.place?.city || session?.firstTouch?.place?.areaCoarse || null,
      agesLabel: summarizeChildren(children),
      parentName: given?.parentName ?? null,
      checklist,
    }),
  );
  return friendOutbound(spoken);
}

/** #868 · where a failed read's hold is written (tests pass a recorder). */
export interface OptOutHoldPort {
  hold(phoneHash: string, now: Date): Promise<void>;
  release(phoneHash: string): Promise<void>;
}

/**
 * #868 · after the turn's read: a failed read (null after the reader's retry) holds the
 * sender from proactive and queued sends; a successful read releases any hold.
 */
async function settleOptOutHold(
  database: Database,
  phoneHash: string,
  body: string,
  reading: OptOutReading | null,
  now: Date,
  hold?: OptOutHoldPort,
): Promise<void> {
  if (body.trim().length === 0) return;
  const port = hold ?? {
    hold: (hash: string, at: Date) => holdSender(database, hash, at),
    release: (hash: string) => releaseSender(database, hash),
  };
  try {
    if (reading === null) await port.hold(phoneHash, now);
    else await port.release(phoneHash);
  } catch (err) {
    // The hold is a guard, never a reason to drop the turn: logged, and the turn goes on.
    console.error(
      { urgent: reading === null, err: err instanceof Error ? err.name : 'unknown' },
      'opt-out hold: write failed',
    );
  }
}

/** What the provider says it already answered (always null on today's transports). */
export type ProviderKeyword = 'stop' | 'start' | 'help';

/** Re-enrolment from the reader's start reading. Null: nothing to re-enrol. */
async function restartFromReader(
  database: Database,
  args: {
    phoneE164: string;
    inbound: Inbound;
    now: Date;
    confirmation: string;
    providerAnswered?: boolean;
  },
  deps: IntakeDeps,
): Promise<IntakeOutcome | null> {
  const owner = await findReenrollableChannelOwner(database, args.phoneE164);
  if (!owner) return null;
  await reenrolOnStart(
    database,
    { ...owner, phoneE164: args.phoneE164, verbatimReply: args.inbound.body },
    args.now,
  );
  if (args.providerAnswered) return { status: 'restarted', ack: 'provider_answered' };
  const body = args.confirmation.trim();
  if (body.length === 0) {
    console.error('opt-out reader: start read with no confirmation - re-enrolled, nothing sent');
    return { status: 'restarted', ack: 'sent' };
  }
  let sent: Awaited<ReturnType<typeof sendResolvingNewChat>>;
  try {
    sent = await sendResolvingNewChat(deps.transport, { to: args.phoneE164, body });
  } catch (error) {
    // VIL-348: an opt-out list that still holds this number refuses the confirmation
    // permanently (21610) although Hale has re-enrolled them. Named, never a 500 that
    // would only retry identically after the consent write. A transient failure throws.
    const refusal = readSendRefusal(error);
    if (!refusal?.permanent) throw error;
    return { status: 'restarted', ack: 'provider_refused' };
  }
  const pipe = messagingPipe(args.inbound);
  const channel = sent.transport === 'imessage' ? 'imessage' : pipe.channel;
  await writeChannelMessage(
    database,
    { familyId: owner.familyId, parentUserId: owner.userId },
    {
      direction: 'out',
      body,
      providerId: sent.providerMessageId,
      at: args.now.toISOString(),
      channel,
      chatId: channel === 'imessage' ? (sent.chatId ?? pipe.chatId) : pipe.chatId,
    },
    args.now,
  );
  return { status: 'restarted', ack: 'sent' };
}

async function handleStop(
  database: Database,
  args: {
    phoneE164: string;
    inbound: Inbound;
    session: IntakeSession | null;
    now: Date;
    /** VIL-348 — the provider matched this STOP and already confirmed it to the sender.
     * Suppresses HALE'S ack and nothing else: every revocation below still runs. */
    providerAnswered: boolean;
    /** Model-written confirmation (opt-out reader). Empty sends nothing; the
     * revocation above it has already run. */
    confirmation?: string;
  },
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  const { phoneE164, inbound, session, now, providerAnswered } = args;

  // A group STOP the roster answered (roster-stop.ts) never reaches here. One it could
  // not answer — no roster yet, a roster that is not open, an unclaimed chat — takes this
  // path, so a STOP never does less than it did before the roster existed.

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
  const body = args.confirmation ?? '';
  if (body.trim().length === 0) return { status: 'stopped', ack: 'voice_unsent' };

  try {
    const sent = await sendResolvingNewChat(deps.transport, {
      to: phoneE164,
      body,
    });
    // The ack is the last outbound this family will get, and it must be on the record
    // like every other (rule #6). Only when an OWNER exists: a guest's or invitee's
    // STOP has no family row to ledger against (channel_messages.family_id NOT NULL),
    // and their consent lives on the RSVP/invite rows handled above.
    if (owner) {
      const pipe = messagingPipe(inbound);
      const channel = sent.transport === 'imessage' ? 'imessage' : pipe.channel;
      await writeChannelMessage(
        database,
        { familyId: owner.familyId, parentUserId: owner.userId },
        {
          direction: 'out',
          body,
          providerId: sent.providerMessageId,
          at: now.toISOString(),
          channel,
          chatId: channel === 'imessage' ? (sent.chatId ?? pipe.chatId) : pipe.chatId,
        },
        now,
      );
    }
  } catch (error) {
    // A PERMANENT refusal means there is no ack to retry. 21610 above all: the provider
    // refusing to text a number that has opted out AT THE CARRIER — the exact number a
    // STOP creates — and it has already sent its own advisory there, so the confirmation
    // IS delivered, by them. The rest (21211, 21614, 21408) mean the handset cannot be
    // reached at all. Either way, 500ing the webhook over an undeliverable courtesy
    // would fail the one message we are legally required to get right. A TRANSIENT
    // failure is still a failure: it throws, and the retry finds the session closed and
    // sends the ack again.
    const refusal = readSendRefusal(error);
    if (!refusal?.permanent) throw error;
  }
  return { status: 'stopped', ack: 'sent' };
}

export type { IntakeState };
