import type Anthropic from '@anthropic-ai/sdk';
import {
  type AgentClient,
  type GuardDeps,
  type RegisteredTool,
  type RunAgentArgs,
  type RunAgentResult,
  type Skill,
  agentRunCostUsd,
  pickModel,
  runAgent,
} from '@hale/agent';
import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { type FamilyCountry, familyCountryOf } from '@hale/types';
import { type FactReader, factsForContext } from '@hale/worker/memory-context';
import { familyHasAutonomyGrant, revokeAutonomyForKind } from '@hale/worker/memory-writer';
import { eq } from 'drizzle-orm';
import { recordAgentRun } from '~/lib/agent-run';
import type { ActivityPromise } from '~/lib/channel/activity/commitment';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { bindActivityReader, productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import {
  type CapabilityNotes,
  type OwedCorrection,
  loadOwedCorrections,
} from '~/lib/channel/capabilities/ledger';
import { type DeferredCapability, darkCapabilities } from '~/lib/channel/capabilities/registry';
import {
  augmentCoachSkillForCapabilities,
  noteCapabilityCorrectionTool,
  noteCapabilityDeclinedTool,
} from '~/lib/channel/capabilities/tools';
import {
  groupPlanDraftPort,
  productionRecordGroupPlanOrigin,
} from '~/lib/channel/group-plan/stamp';
import {
  type InboundMediaPart,
  type ReadInboundMedia,
  readInboundMedia,
} from '~/lib/channel/inbound-media';
import {
  ageFitCorrectionEnabled,
  appendAgeFitCorrectionSkill,
} from '~/lib/channel/intake/age-fit-correction';
  type PhotoFacts,
  type ReadPhotoFactsInput,
  augmentCoachSkillForPhotoFacts,
  extractInboundPhotoFacts,
  inboundPhotoFactsEnabled,
  photoFactSignupLinks,
} from '~/lib/channel/inbound-photo-facts';
import { loadHouseholdGroupFact } from '~/lib/channel/intake/household-group';
import {
  linqExperiencesEnabled,
  linqGroupLeaveEnabled,
  linqVoiceMemosEnabled,
} from '~/lib/channel/linq/config';
import { type GroupLeaveEligibility, groupLeaveEligibility } from '~/lib/channel/linq/group-leave';
import { hearVoiceMemo } from '~/lib/channel/linq/voice-speech';
import { groupSharedListsEnabled } from '~/lib/channel/lists/flag';
import {
  appendGroupListsReply,
  augmentCoachSkillForGroupLists,
  createGroupListJournal,
  undoGroupListWrites,
} from '~/lib/channel/lists/tools';
import { midActivitySignupToolEnabled } from '~/lib/channel/mid-activity/said-tool';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import type { PlanOffer } from '~/lib/channel/plan/offer';
import { type ReferralShare, referralBlock } from '~/lib/channel/referral/share';
import {
  type ChannelCoachRuntime,
  type ChannelTurn,
  ChannelTurnFailed,
  type ChannelTurnResult,
} from '~/lib/channel/router/coach-runtime';
import { augmentCoachSkillForStopWatching } from '~/lib/channel/spots/stop-tool';
import {
  type SpotWatchIntent,
  loadParentLiveWatches,
  releaseWatchByParent,
} from '~/lib/channel/spots/store';
import { MINT_FETCH_TIMEOUT_MS } from '~/lib/channel/spots/tool';
import {
  type AgentContext,
  type LoadAgentContextInput,
  loadAgentContext,
} from '~/lib/coach/context';
import { type TranscriptMessage, loadTranscript } from '~/lib/coach/conversation';
import { buildGuardDeps } from '~/lib/coach/guards';
import { type OfferedCandidate, searchVillageTool } from '~/lib/coach/tools';
import { POLICY_VERSION } from '~/lib/consent';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { loadCronSkill } from '~/lib/cron/skill';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { HOT_SMS_CLIENT_OPTIONS, activityClient, budgetedAnthropic } from '~/lib/pipeline/client';
import { createLiveClassAvailabilityReader } from '~/lib/registration/class-availability';
import { createFetchBody } from '~/lib/registration/verify-sweep';
import {
  activityReviewsSurfaceEnabled,
  familyAreaKey,
  nearbyClauseTarget,
  offeredSubject,
  readSubjectVerdicts,
} from '~/lib/reviews/aggregate';
import {
  type ProviderWatchContext,
  loadProviderWatchContext,
} from '~/lib/signup/browser-use/watch/context';
import { browserUseWatchEnabled } from '~/lib/signup/browser-use/watch/flag';
import { augmentCoachSkillForProviderWatch } from '~/lib/signup/browser-use/watch/tools';
import { augmentCoachSkillForSignupOffer, signupOfferToolEnabled } from '~/lib/signup/offer-tool';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { linkRef } from './activity-links';
import { augmentCoachSkillForAutonomySwitchOff } from './autonomy-switch-off-tool';
import { draftOriginForTurn, productionChannelDraftPort } from './draft';
import { dropEmailOnlyTokens } from './email-only-tokens';
import {
  type ExperienceCardIntent,
  augmentCoachSkillForExperienceCards,
  shareExperienceCardTool,
} from './experience-card-tool';
import {
  type FindTurnReading,
  augmentCoachSkillForFindPrivate,
  createFindTurnReader,
} from './find-private';
import { type FindReplyGate, judgeWholeFindReply } from './find-reasoning-judge';
import { GmailDraftNoticeUnsent } from './gmail-draft-notice';
import {
  type GmailDraftNoticeBox,
  augmentCoachSkillForGoogleDrafts,
  productionGmailDraftPorts,
} from './gmail-draft-tool';
import {
  type GroupLeaveIntent,
  augmentCoachSkillForGroupLeave,
  leaveGroupChatTool,
} from './group-leave-tool';
import { groupScopedContext, groupScopedTools } from './group-privacy-scope';
import {
  type ForecastDay,
  augmentCoachSkillForLocalDay,
  loadCoachForecast,
  loadCoachTimeZone,
  localDayContext,
} from './local-day';
import { familyLocalNow } from './local-now';
import { appendNoGroupRelaySkill, group1to1NoGroupRelayEnabled } from './no-group-relay';
import {
  type CoachEmailReader,
  READ_EMAIL_SKILL,
  augmentCoachSkillForReadEmail,
  productionCoachEmailReader,
  readEmailTool,
  taintTurnOnEmailRead,
} from './read-email-tool';
import {
  type RegistrationWindowContext,
  loadRegistrationWindows,
  productionRegistrationContextPorts,
} from './registration-context';
import { redactTeenNames } from './reply';
import { type ReplyChild, toSmsReply } from './reply';
import {
  type TurnOfferLedger,
  buildChannelCoachTools,
  channelScheduleReader,
  createTurnOfferLedger,
} from './tools';
import { augmentCoachSkillForVoiceMemos, replyAsVoiceMemoTool } from './voice-memo-tool';

/**
 * VIL-221 · C2 — the coach, over SMS.
 *
 * The harness, the guarded invoker, the family context assembly, and teen redaction
 * at the source. What a text can afford is the difference, and each one below is a
 * consequence of the surface:
 *
 *   NO STREAMING. A carrier takes one body, once. So the loop is `runAgent`, not
 *   `runAgentStreaming`, and the answer is assembled before anything is sent — which
 *   is also why the post-processor can hold a segment budget at all.
 *
 *   A TERSER VOICE. The `coach-channel-sms` skill. Same instructions about honesty
 *   and scope, a shorter answer shape, because markdown and a four-paragraph answer
 *   are a worse artifact on a phone than a short one.
 *
 *   SCHEDULE VERBS. The three propose_* tools plus lookup_week. Every one drafts
 *   (rule #4).
 *
 * WHAT THIS DOES NOT DO, deliberately: it never touches `messages`. C1 appends the
 * parent's turn before calling in, and appends the reply after the transport accepts
 * it, so the thread reflects what was actually SENT. A write here would put Hale's
 * answer in the parent's history before it existed. Nothing in {@link ChannelCoachPorts}
 * can write to that table, which is the structural half of the promise.
 *
 * A failed turn THROWS. The router owns what a parent hears next (route.ts
 * disposeOfFailedTurn): a model writes it from facts, or nothing is sent. That
 * path only runs when a failure looks like one.
 */

/** The whole turn's model budget. Six steps is enough for lookup_week → resolve → two
 * drafts → answer, and a hard stop short of a loop that would outrun the ack. */
const MAX_STEPS = 6;
/**
 * The whole COMPLETION budget for one step — thinking, tool calls, and text share it.
 *
 * 400 was a reply ceiling when this lane emitted text and nothing else. Then `converse`
 * became `{ thinking: 'adaptive', effort: 'high' }` and the 400 was spent thinking:
 * prod's failed `coach-channel-sms` run on 2026-08-22 returned 399 thinking tokens and
 * no text. The thinking-off re-ask at that same 400 still offered tools, so a broad
 * follow-up could spend the recovery on another call and never speak — VIL-536, Preview
 * 2026-11-01: "show me everything you found, grouped", `truncated before speaking
 * (1 re-ask)`, `draftedThisTurn` 0, parent got the failed-turn apology.
 *
 * 2000 is the ceiling thinking, tools, and a grouped reply can share on the first
 * attempt (PR #998). `runAgent` still re-asks a step that hits it before saying
 * anything, once, with thinking off and with tools dropped, so the leftover cannot be
 * spent on another call (`isTruncatedBeforeSpeaking`, `withoutThinking`). Changing this
 * number moves the coach prompt-cache keys.
 */
export const CHANNEL_COACH_MAX_TOKENS = 2000;
const MAX_TOKENS = CHANNEL_COACH_MAX_TOKENS;

/** The agent_runs name for a texted turn (migration 0075). The texted coach is the
 * live surface, with its own latency and cost shape. */
export const CHANNEL_AGENT_NAME = 'coach-channel-sms';

export interface ChannelRunRecord {
  familyId: string;
  agentName: typeof CHANNEL_AGENT_NAME;
  status: 'completed' | 'failed';
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Any turn of the loop read from the prompt cache (MEM-9 telemetry). */
  promptCacheHit: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  langfuseTraceId: string | null;
}

/**
 * Everything the runtime needs from the outside world. All of it is injected so the
 * plumbing is testable without a database, a network, or a model — and, just as
 * importantly, so the set is READABLE as the complete list of what a texted turn can
 * touch. There is no write port here, and that is the point.
 */
export interface ChannelCoachPorts {
  loadSkill(parentUserId: string, familyId: string): Promise<Skill>;
  loadTranscript(conversationId: string): Promise<TranscriptMessage[]>;
  loadContext(input: LoadAgentContextInput): Promise<AgentContext>;
  /** Every child of the family, un-redacted — the redactor needs the real names to
   * find them in the answer, and it is the only consumer. */
  loadChildren(familyId: string): Promise<ReplyChild[]>;
  /** The municipal registration windows this family can still act on, and whether the
   * ladder is armed for them — Hale's flagship job, made visible to a turn that is
   * being asked about it (see registration-context.ts). */
  loadRegistrationWindows(familyId: string, now: Date): Promise<RegistrationWindowContext[]>;
  /** What Hale's Browser Use watch last read on this family's providers (schedules,
   * openings, waitlists), as data. Optional: absent or empty leaves the context key out,
   * so an ordinary turn's prompt bytes are unchanged (signup/browser-use/watch/context.ts). */
  loadProviderWatch?(familyId: string, now: Date): Promise<ProviderWatchContext[]>;
  /** VIL-628 · the values of the facts this parent told Hale (`memory_source =
   * parent_message`), read only on a turn that read an email: what its reply may repeat.
   * Optional: absent, the reply may repeat only the parent's words in this thread.
   * Goes through `factsForContext` so another adult's 1:1 never trusts a token (VIL-599). */
  loadParentStatedFacts?(familyId: string, parentUserId: string, now: Date): Promise<string[]>;
  /** The family's own IANA time zone, or null when Hale does not know it (VIL-435).
   * Optional: absent or null, the turn carries only the UTC instant, as before. */
  loadTimeZone?(familyId: string): Promise<string | null>;
  /** Their coarse area's outlook, today onward (VIL-435). Optional: absent or empty
   * leaves the key out. */
  loadForecast?(familyId: string): Promise<ForecastDay[]>;
  /** VIL-303 · this parent's earlier noes that are true now. Optional: absent or empty
   * leaves the key, the addendum and the correction verb out. */
  loadOwedCorrections?(familyId: string, parentUserId: string): Promise<OwedCorrection[]>;
  /** `onDraft` is called with every actionId the turn mints, so a failure can say what
   * it already committed rather than claiming nothing happened (VIL-260); `onOffer`
   * with the full plan the turn offered, which the router writes down after the send;
   * `onShare` with the referral line and link, which never leaves this runtime — it is
   * appended to the reply, and a link a parent forwards is not a thing to persist. */
  buildTools(
    turn: ChannelTurn,
    onDraft: (actionId: string) => void,
    onOffer: (offer: PlanOffer) => void,
    onShare: (share: ReferralShare) => void,
    onPromise: (promise: ActivityPromise) => void,
    onWatch: (watch: SpotWatchIntent) => void,
    /** The turn's offer ledger, owned by the runtime so the provenance match and the
     * nearby count read the same list. */
    offered: TurnOfferLedger,
    onGmailNotice: ((notice: GmailDraftNoticeBox) => void) | undefined,
    /** VIL-447: a tool registers how to undo a write it made; a failed turn runs them. */
    onUndo: ((undo: () => Promise<void>) => void) | undefined,
    /** The family row's country, read off the turn's own context (familyCountryOf). */
    familyCountry: FamilyCountry | null,
  ): RegisteredTool[];
  /**
   * WHAT OTHER FAMILIES NEARBY SAID about one of the activities this turn offered, or
   * null — which is the answer for every turn until three REAL households have answered
   * about one subject, and while `ACTIVITY_REVIEWS_SURFACE` is off.
   *
   * A PORT rather than a read inside the loop: the decision is one indexed scan and a
   * pure gate, and putting it behind the same seam as everything else here keeps the
   * runtime testable without a database.
   */
  nearbySaid(
    familyId: string,
    offers: readonly OfferedCandidate[],
  ): Promise<{ clause: string; title: string; otherTitles: string[] } | null>;
  guardDeps: GuardDeps;
  /**
   * VIL-497 — whether Linq experience cards are lit (`LINQ_EXPERIENCES_ENABLED`). Absent
   * or false: the card verb is not registered and the skill is untouched, so a dark turn's
   * prompt bytes and cache prefix are exactly main's. Never offered on a group turn.
   */
  experienceCardsEnabled?(): boolean;
  /**
   * VIL-495 — whether Linq voice memos are lit (`LINQ_VOICE_MEMOS_ENABLED`). Absent or
   * false: the voice verb is not registered and the skill is untouched, so a dark turn's
   * prompt bytes and cache prefix are exactly main's. Never offered on a group turn.
   */
  voiceMemosEnabled?(): boolean;
  /**
   * VIL-477 — whether Hale may leave a group on a member's explicit ask
   * (`LINQ_GROUP_LEAVE_ENABLED`). Absent or false: the verb is not registered and the
   * skill is untouched. Only ever offered on a group turn.
   */
  groupLeaveEnabled?(): boolean;
  /** VIL-477 — the leave guard, run before the reply so a decline is told to the model. */
  groupLeaveCheck?(chatId: string): Promise<GroupLeaveEligibility>;
  /**
   * VIL-433 — the parent's own Gmail, read only for an email an alert in this thread named.
   * Offered on a 1:1 turn whose parent has it connected; never on a group turn. Absent, or
   * not connected: no verb and the skill is untouched.
   */
  emailReader?: CoachEmailReader;
  /**
   * The Anthropic client the loop drives, resolved LAZILY — a function, not a value.
   *
   * The router builds its deps for EVERY inbound text, including the ones a
   * deterministic handler answers without a model ("YES 2", "done", a waitlist report).
   * Constructing the client at wiring time would make a missing ANTHROPIC_API_KEY throw
   * before those handlers ever ran, turning a config gap into "Hale stopped accepting
   * approvals". Deferring it means the key is only required by the turn that needs one.
   */
  client(): AgentClient;
  /**
   * VIL-524 / VIL-567. Whether this inbound is a nearby-find, in any language.
   * Production wires a model read. Absent: not a find — scripted tests that are
   * not about the gate, and a missing client in production, fail the same way so
   * a calendar edit is never treated as a search.
   */
  readFindTurn?(input: {
    text: string;
    transcript: readonly { role: string; content: string }[];
  }): Promise<FindTurnReading>;
  /**
   * VIL-524. On a nearby-find turn, after the model writes, this decides whether
   * the whole reply is internal reasoning. Required: production wires the model
   * judge, and a scripted coach passes `findReplyNotJudged`, which sends the draft
   * and logs `not_configured` (rule #11). A judge that withholds or fails sends
   * nothing. The judge does not rewrite parent text.
   */
  judgeFindReply(draft: string): Promise<FindReplyGate>;
  /**
   * Fetch this turn's images into content blocks, and a `.vcf` into contact fields.
   * Absent is a named gap: the parts are still told to the model as unwatched, and
   * nothing is fetched.
   */
  readInboundMedia?(
    parts: readonly InboundMediaPart[],
    audience: ChannelTurn['audience'],
  ): Promise<ReadInboundMedia>;
  /**
   * VIL-413 — whether this turn may extract facts from an inbound photo or PDF
   * (`INBOUND_PHOTO_FACTS_ENABLED`). Absent or false: no extract call, no
   * photoFacts key, no addendum, and PDFs stay unwatched files. Dark turns keep
   * today's prompt bytes.
   */
  photoFactsEnabled?(): boolean;
  /**
   * VIL-413 — read this turn's image/PDF blocks into facts. Absent while the
   * flag is lit is a named gap: the image still reaches the coach, and no
   * canned line is sent.
   */
  readPhotoFacts?(input: ReadPhotoFactsInput): Promise<PhotoFacts | null>;
  runAgent(args: RunAgentArgs): Promise<RunAgentResult>;
  recordRun(run: ChannelRunRecord): Promise<void>;
  now(): Date;
}

export function channelCoachRuntime(ports: ChannelCoachPorts): ChannelCoachRuntime {
  return {
    async respond(
      turn: ChannelTurn,
      rejectedLastAttempt: readonly string[],
    ): Promise<ChannelTurnResult> {
      // This turn's own ledger of committed drafts. Every exit that is not an answer
      // carries it out (see `failed` below) — a draft is a row the parent can approve,
      // so a failure that hid it would leave them holding an action they never heard of.
      const draftedActionIds: string[] = [];
      // The plan this turn offered, if it offered one. LAST CALL WINS rather than a
      // list: the skill allows exactly one question per message, so a second offer in
      // one turn is a model that changed its mind mid-compose, and the offer the parent
      // can actually see is the one in the sentence it ended up writing.
      let planOffer: PlanOffer | null = null;
      // The referral link this turn handed over, if it did. Local to the runtime: unlike
      // an offer, nothing later resolves against it — there is no YES to match and no
      // ledger row to mint, because the parent forwarding a message is not a promise
      // Hale owes them.
      let referral: ReferralShare | null = null;
      // The "I'll come back to you" this turn said, if it said one. LAST CALL WINS, for
      // the reason the offer's does: the ledger permits one open activity promise per
      // family, so a turn that registered two changed its mind mid-compose and the one
      // the parent can read is the one in the sentence it ended up writing.
      let activityPromise: ActivityPromise | null = null;
      // What `search_village` put in front of the parent this turn — the rows, not the
      // sentences. It feeds two things that must never disagree: the `sourceRef` a
      // texted add records, and the nearby count appended below.
      const offeredThisTurn = createTurnOfferLedger();
      // The course page this turn started watching, if it started one. LAST CALL WINS
      // like the two above: one arming sentence can be written per message, so a second
      // call is a model that changed its mind mid-compose, and the page the parent can
      // read about is the one in the sentence it ended up writing.
      let spotWatch: SpotWatchIntent | null = null;
      let gmailNotice: GmailDraftNoticeBox | null = null;
      // VIL-497: the one find this turn chose to send as a card. LAST CALL WINS.
      let experienceCard: ExperienceCardIntent | null = null;
      // VIL-477: a member asked Hale to leave this group. LAST CALL WINS.
      let groupLeave: GroupLeaveIntent | null = null;
      // VIL-495: the model chose to say this reply as a voice memo.
      let voiceChosen = false;
      // VIL-447: writes a failed turn must take back (shared-list adds and check-offs), so
      // the router's "nothing was changed" is true. Run newest first; an undo that fails
      // is logged by fault class and never masks the turn's own failure.
      const undos: Array<() => Promise<void>> = [];
      const undoAll = async () => {
        for (const undo of undos.splice(0).reverse()) {
          await undo().catch((err: unknown) =>
            console.error(
              { fault: err instanceof Error ? err.name : typeof err },
              'coach: turn write undo failed',
            ),
          );
        }
      };
      const failed = (message: string, cause?: unknown): ChannelTurnFailed =>
        new ChannelTurnFailed(message, { cause, draftedActionIds });

      const now = ports.now();
      const [loadedSkill, transcript, children, registrationWindows, timeZone, forecast] =
        await Promise.all([
          ports.loadSkill(turn.parentUserId, turn.familyId),
          ports.loadTranscript(turn.conversationId),
          ports.loadChildren(turn.familyId),
          ports.loadRegistrationWindows(turn.familyId, now),
          ports.loadTimeZone ? ports.loadTimeZone(turn.familyId) : null,
          ports.loadForecast ? ports.loadForecast(turn.familyId) : [],
        ]);
      const localDay = localDayContext(timeZone ? familyLocalNow(now, timeZone) : null, forecast);
      const providerWatch = ports.loadProviderWatch
        ? await ports.loadProviderWatch(turn.familyId, now)
        : [];
      // The 1:1 skill stays byte-identical. The group section is a second file,
      // loaded only when this turn is the family group.
      const cardsLit = turn.audience !== 'group' && (ports.experienceCardsEnabled?.() ?? false);
      const leaveLit = turn.audience === 'group' && (ports.groupLeaveEnabled?.() ?? false);
      const voiceLit = turn.audience !== 'group' && (ports.voiceMemosEnabled?.() ?? false);
      const emailReader = turn.audience !== 'group' ? ports.emailReader : undefined;
      const emailLit =
        emailReader !== undefined &&
        (await emailReader.connected(turn.familyId, turn.parentUserId));
      const groupedSkill =
        turn.audience === 'group'
          ? // VIL-447: the shared-list verbs exist only in a group, and only with the flag on.
            augmentCoachSkillForGroupLists(
              await appendGroupCoachSkill(loadedSkill),
              groupSharedListsEnabled(),
            )
          : loadedSkill;
      // VIL-510: nearby-find voice + link rules ride as an addendum so the disk
      // coach-channel-sms bytes (and every eval recording keyed on them) stay put.
      const nearbyFind = await loadCronSkill('coach-nearby-find');
      // Postal town is home. A separate file so the standing coach-channel recordings,
      // keyed on sms + nearby-find, stay put until they are re-recorded.
      const homePlace = await loadCronSkill('coach-home-place');
      const baseSkill = {
        ...groupedSkill,
        instructions: `${groupedSkill.instructions}\n\n${nearbyFind.instructions}\n\n${homePlace.instructions}`,
      };
      // VIL-524 / VIL-567. Only a nearby-find turn gets these addenda. A model
      // reads the parent's words in any language; there is no word list. Absent
      // port or a failed read is not a find. coach-nearby-find itself stays
      // byte-identical, so coach-channel and group-privacy recordings stay keyed
      // on the prompt they already have.
      const findTurn = ports.readFindTurn
        ? (await ports.readFindTurn({ text: turn.body, transcript })).findTurn
        : false;
      const findPrivate = findTurn ? await loadCronSkill('coach-find-private') : null;
      // VIL-567: the same gate, so a bare find reads its day from the thread.
      const findDay = findTurn ? await loadCronSkill('coach-find-day') : null;
      // Dark and group turns pass null: the disk skill object is unchanged (VIL-497).
      // Lit 1:1 appends experience-card-coach so citing a ref is not a substitute for
      // the card when the answer is one venue's page (VIL-500).
      // VIL-482. Only a turn that carried a .vcf gets this addendum. Anything else
      // keeps the same skill object, so coach-channel and group-privacy recordings
      // stay keyed on the bytes they already have.
      const contactCard = turn.inboundMedia?.some((part) => part.kind === 'contact')
        ? await loadCronSkill('contact-card-read')
        : null;
      const composedSkill = augmentCoachSkillForContactCard(
        augmentCoachSkillForReadEmail(
      const composedSkill = augmentCoachSkillForReadEmail(
        augmentCoachSkillForFindPrivate(
          augmentCoachSkillForFindPrivate(
            augmentCoachSkillForGroupLeave(
              augmentCoachSkillForVoiceMemos(
                augmentCoachSkillForExperienceCards(
                  baseSkill,
                  cardsLit ? await loadCronSkill('experience-card-coach') : null,
                ),
                voiceLit ? await loadCronSkill('coach-voice-memo') : null,
              ),
              leaveLit,
            ),
            findPrivate,
          ),
          emailLit ? await loadCronSkill(READ_EMAIL_SKILL) : null,
          findDay,
        ),
        contactCard,
      );
      // The ref→page table for this turn: the same list the reply's [link-…] markers
      // resolve against, so a card and a cited link can never point at different pages.
      const turnLinks = () =>
        [
          ...offeredThisTurn.read().flatMap((item) => (item.url ? [item.url] : [])),
          ...offeredThisTurn.links().map((link) => link.url),
        ].map((url) => ({ ref: linkRef(url), url }));

      const familyContext = await ports.loadContext({
        familyId: turn.familyId,
        question: turn.body,
        intent: null,
        // A text has no per-child chip to focus, so the turn is whole-family and the
        // model resolves who is meant from the words and the schedule.
        focusedChildId: null,
        transcript,
        sourceNote: null,
        readerUserId: turn.parentUserId,
        inGroup: turn.audience === 'group',
      });
      // VIL-566: the household-group addendum rides only when the fact does, so every
      // other turn keeps its system bytes. VIL-429's fact-source addendum is the same:
      // only a 1:1 turn holding a fact Hale read in email or the calendar carries it.
      const householdSkill = familyContext.householdGroup
        ? await appendHouseholdGroupSkill(composedSkill)
        : composedSkill;
      const sourcedSkill =
        turn.audience !== 'group' && familyContext.memoryFacts.some((fact) => fact.seenIn)
          ? await appendFactSourceSkill(householdSkill)
          : householdSkill;
      // VIL-435: the local-day addendum rides only when a day fact does.
      const dayedSkill = augmentCoachSkillForLocalDay(
        sourcedSkill,
        Object.keys(localDay).length > 0 ? await loadCronSkill('coach-local-day') : null,
      );
      // VIL-303: a 1:1 turn may say a deferred capability is not real yet while one is
      // dark, and carries a correction while this parent is owed one. A group turn does
      // neither: the no and its correction belong to the parent who heard the no.
      const darkNow = turn.audience === 'group' ? [] : darkCapabilities(turn.familyId);
      const owedCorrections =
        turn.audience === 'group' || !ports.loadOwedCorrections
          ? []
          : await ports.loadOwedCorrections(turn.familyId, turn.parentUserId);
      const skill = augmentCoachSkillForCapabilities(dayedSkill, {
        declined: darkNow.length > 0,
        correction:
          owedCorrections.length > 0 ? await loadCronSkill('coach-capability-correction') : null,
      });
      const declined: DeferredCapability[] = [];
      const corrected: DeferredCapability[] = [];
      // VIL-568: age-fit correction rides only on a 1:1 turn with the flag on.
      // Dark and group turns keep the skill bytes they already had.
      const withAgeFit = appendAgeFitCorrectionSkill(
        skill,
        turn.audience !== 'group' && ageFitCorrectionEnabled()
          ? await loadCronSkill('age-fit-correction')
          : null,
      );
      // VIL-577: a 1:1 yes or ask to tell the group rides only with the flag on.
      // Dark and group turns keep the skill bytes they already had. The aside
      // already never offers; this is the later coach turn.
      const withNoRelay = appendNoGroupRelaySkill(
        withAgeFit,
        turn.audience !== 'group' && group1to1NoGroupRelayEnabled()
          ? await loadCronSkill('coach-no-group-relay')
          : null,
      );
      // VIL-447: list reply tone rides last, and only on a group turn with the flag on.
      // Dark and 1:1 turns keep the skill bytes they already had.
      const coachSkill =
        turn.audience === 'group' && groupSharedListsEnabled()
          ? await appendGroupListsReply(withNoRelay)
          : withNoRelay;

      // NO app link anywhere on this path, deliberately. The thread does the work and
      // the app is the receipts room a parent never needs, so a reply that sends them
      // there hands the job back to the person who texted to be rid of it — which is
      // what happened on launch day ("You can also add anything manually in the app:
      // https://…"). The skill says not to; a skill is a request. Holding no URL at all
      // is the guarantee: the model composes no link because it was handed none, and
      // the post-processor cannot append one to an over-budget reply because it no
      // longer takes one either (skill audit P0 #4).
      //
      // THE REFERRAL LINK DID NOT BREAK THAT, which is the whole reason it is shaped the
      // way it is. `share_referral_link` returns `{ shared: true }` and nothing else —
      // the URL is assembled down in this function, after the fit, from the family id.
      // So the invariant still reads exactly as it did: a URL in a model's answer is a
      // URL it invented. The one link Hale now sends is the one it was never in a
      // position to get wrong, and it points at /text (a stranger's front door) rather
      // than at the app.
      const context = {
        ...familyContext,
        channel: 'sms' as const,
        nowIso: now.toISOString(),
        // TODAY WHERE THE FAMILY LIVES, AND ITS WEATHER (VIL-435). Facts for the model to
        // reason over (a holiday there? a day for indoors?), never a filter and never
        // copy. Each key is absent when unknown.
        ...localDay,
        // What Hale is holding an answer for, in Hale's own words (see ChannelTurn). A
        // FACT about state, handed to the model the same way the family's schedule is —
        // so a turn that is plainly an answer to one of them can be treated as one, and a
        // turn that is not can stop claiming nothing is pending when something is.
        standingQuestions: turn.standingQuestions,
        // WHAT THE LAST ATTEMPT CLAIMED AND COULD NOT BACK (VIL-293). Absent on every
        // first attempt — the key does not appear at all rather than appearing empty, so
        // the ordinary turn's prompt bytes, and its cache prefix, are untouched.
        ...(rejectedLastAttempt.length > 0 ? { rejectedLastAttempt } : {}),
        // THE FAMILY GROUP (group onboarding v2). Absent on a 1:1 turn for the reason the
        // key above is: the ordinary turn's prompt bytes and cache prefix stay untouched.
        ...(turn.audience === 'group' ? { audience: 'group' as const } : {}),
        // The hand-verified municipal open dates this family must act on, soonest
        // first, each saying whether Hale's ladder is already on it. Empty for a family
        // outside the covered set — and then the skill has nothing to claim.
        registrationWindows,
        // What the watch last read on this family's providers. Absent when empty, so
        // the ordinary turn's prompt bytes and cache prefix are untouched.
        ...(providerWatch.length > 0 ? { providerWatch } : {}),
        // VIL-303: absent unless this parent is owed a correction, for the same reason.
        ...(owedCorrections.length > 0 ? { capabilityCorrections: owedCorrections } : {}),
      };
      const media = await mediaForTurn(turn, ports);
      if (media.unwatched.length > 0) {
        Object.assign(context, { arrivedMedia: media.unwatched });
      }
      // VIL-482. Facts from a .vcf the parent attached. Absent when this turn had
      // none, so an ordinary turn's prompt bytes stay the same.
      if (media.contacts.length > 0) {
        Object.assign(context, {
          arrivedContacts: media.contacts,
          ...(media.contactsTruncated ? { arrivedContactsTruncated: true } : {}),
        });
      }
      const photoFacts = await photoFactsForTurn(turn, ports, media.blocks, now, timeZone);
      const skillForTurn = photoFacts
        ? augmentCoachSkillForPhotoFacts(coachSkill, await loadCronSkill('coach-photo-facts'))
        : coachSkill;
      if (photoFacts) {
        Object.assign(context, { photoFacts });
      }
      const turnForTools = photoFacts ? { ...turn, photoFacts } : turn;
      // VIL-439 (T18): every group turn sees only group-safe context and tools. No flag:
      // the router sets the group audience for any message the door marked in_group.
      const groupScoped = turn.audience === 'group';
      const turnContext = groupScoped ? groupScopedContext(context) : context;

      return traceAgentRun(
        {
          name: CHANNEL_AGENT_NAME,
          sessionId: turn.conversationId,
          userId: turn.parentUserId,
          tags: [CHANNEL_AGENT_NAME, familyContext.planTier].filter(Boolean) as string[],
          metadata: { familyId: turn.familyId },
        },
        async (trace) => {
          try {
            const startedAt = Date.now();
            // A fresh tool set per turn: the two-draft cap is a closure inside it, so a
            // reused set would spend this text's budget on the last one's.
            const builtTools = ports.buildTools(
              turnForTools,
              (actionId) => draftedActionIds.push(actionId),
              (offer) => {
                planOffer = offer;
              },
              (share) => {
                referral = share;
              },
              (promise) => {
                activityPromise = promise;
              },
              (watch) => {
                spotWatch = watch;
              },
              offeredThisTurn,
              (notice) => {
                if (gmailNotice?.status === 'unsent') return;
                gmailNotice = notice;
              },
              (undo) => {
                undos.push(undo);
              },
              familyCountryOf(familyContext.location.country),
            );
            // VIL-439 (T18): no inbox, memory or Gmail tools in a group, and calendar reads
            // are busy-only, on every group turn. VIL-615: once read_email returns text,
            // only reads run for the rest of the turn.
            const { tools, emailRead, emailTexts } = taintTurnOnEmailRead([
              ...(groupScoped ? groupScopedTools(builtTools) : builtTools),
              ...(cardsLit
                ? [
                    shareExperienceCardTool({
                      links: turnLinks,
                      onCard: (card) => {
                        experienceCard = card;
                      },
                    }),
                  ]
                : []),
              ...(voiceLit
                ? [
                    replyAsVoiceMemoTool({
                      onChoose: () => {
                        voiceChosen = true;
                      },
                    }),
                  ]
                : []),
              ...(leaveLit
                ? [
                    leaveGroupChatTool({
                      memberWords: turn.body,
                      onLeave: (intent) => {
                        groupLeave = intent;
                      },
                      ...(ports.groupLeaveCheck
                        ? {
                            check: async () => {
                              const chatId = turn.groupChatId;
                              if (!chatId)
                                return { ok: false as const, reason: 'not_group' as const };
                              const g = await ports.groupLeaveCheck!(chatId);
                              if (g.status === 'eligible') return { ok: true as const };
                              if (g.status === 'failed')
                                return { ok: false as const, reason: 'unavailable' as const };
                              return {
                                ok: false as const,
                                reason:
                                  g.reason === 'no_explicit_ask'
                                    ? ('unavailable' as const)
                                    : g.reason,
                              };
                            },
                          }
                        : {}),
                    }),
                  ]
                : []),
              ...(darkNow.length > 0
                ? [
                    noteCapabilityDeclinedTool({
                      dark: darkNow,
                      onDeclined: (capability) => declined.push(capability),
                    }),
                  ]
                : []),
              ...(owedCorrections.length > 0
                ? [
                    noteCapabilityCorrectionTool({
                      owed: owedCorrections.map((owed) => owed.capability),
                      onCorrected: (capability) => corrected.push(capability),
                    }),
                  ]
                : []),
              ...(emailLit && emailReader
                ? [
                    readEmailTool((gmailMessageId) =>
                      emailReader.read({
                        familyId: turn.familyId,
                        parentUserId: turn.parentUserId,
                        conversationId: turn.conversationId,
                        gmailMessageId,
                      }),
                    ),
                  ]
                : []),
            ]);
            // A tool that throws, a provider that times out, a step that runs long: the
            // loop can break anywhere, and by then the drafts it made are already rows.
            // Re-thrown rather than handled — the router owns what a parent is told.
            const result = await ports
              .runAgent({
                skill: skillForTurn,
                context: turnContext,
                tools,
                client: ports.client(),
                maxSteps: MAX_STEPS,
                maxTokens: MAX_TOKENS,
                toolContext: { familyId: turn.familyId, actor: turn.parentUserId },
                guardDeps: ports.guardDeps,
                ...(media.blocks.length > 0 ? { attachments: media.blocks } : {}),
              })
              .catch((err: unknown) => {
                throw failed(
                  err instanceof Error ? err.message : 'channel coach: agent loop failed',
                  err,
                );
              });

            const modelUsed = pickModel(skillForTurn.meta.task);
            trace.recordGeneration(`${CHANNEL_AGENT_NAME}-loop`, {
              model: modelUsed,
              usage: result.usage,
            });

            const record = (status: 'completed' | 'failed'): ChannelRunRecord => ({
              familyId: turn.familyId,
              agentName: CHANNEL_AGENT_NAME,
              status,
              latencyMs: Date.now() - startedAt,
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              costUsd: agentRunCostUsd(modelUsed, result.usage),
              promptCacheHit: result.usage.cacheReadTokens > 0,
              cacheReadTokens: result.usage.cacheReadTokens,
              cacheWriteTokens: result.usage.cacheCreationTokens,
              langfuseTraceId: trace.traceId,
            });

            if (gmailNotice?.status === 'unsent') {
              await ports.recordRun(record('failed'));
              throw failed(
                'channel coach: gmail draft notice was not sent',
                new GmailDraftNoticeUnsent(),
              );
            }

            if (result.answer === null && gmailNotice?.status !== 'ready') {
              await ports.recordRun(record('failed'));
              throw failed(
                result.hitMaxSteps
                  ? 'channel coach: agent hit maxSteps without an answer'
                  : result.truncated
                    ? // The ceiling failed, not the model and not the context — a
                      // distinct event from "said nothing for its own reasons", and the
                      // only one of the three a lane-config change can fix (rule #11).
                      `channel coach: agent truncated before speaking (${result.truncatedRetries} re-ask)`
                    : 'channel coach: agent returned no answer',
              );
            }

            const share = referral as ReferralShare | null;
            const offer = planOffer as PlanOffer | null;
            // PRECEDENCE: a promise or a link wins, and the count is not even looked up.
            // A count is the least important thing in any message that also carries one of
            // those — and a turn that offered nothing has nothing to count about.
            const nearby =
              offer === null && share === null
                ? await ports.nearbySaid(turn.familyId, offeredThisTurn.read())
                : null;
            const noticeReady = gmailNotice !== null && gmailNotice.status === 'ready';
            const drafted =
              gmailNotice !== null && gmailNotice.status === 'ready'
                ? gmailNotice.text
                : result.answer;
            if (!drafted) {
              await ports.recordRun(record('failed'));
              throw failed(
                'channel coach: gmail draft notice was not sent',
                new GmailDraftNoticeUnsent(),
              );
            }
            // VIL-628: after read_email, a phone, code or host only the email gave is cut
            // before the judge reads the draft, so the judge sees what is sent.
            const emails = emailTexts();
            const { text: spoken, dropped } = dropEmailOnlyTokens(drafted, {
              emails,
              trusted:
                emails.length > 0
                  ? [
                      ...trustedAfterEmail(turn, transcript),
                      ...((await ports.loadParentStatedFacts?.(
                        turn.familyId,
                        turn.parentUserId,
                        now,
                      )) ?? []),
                    ]
                  : [],
            });
            if (Object.values(dropped).some((count) => count > 0)) {
              console.info(
                { outcome: 'email_only_tokens_dropped', ...dropped },
                'channel coach: reply tokens only the email gave were dropped',
              );
            }
            if (spoken === '') {
              await ports.recordRun(record('failed'));
              throw failed('channel coach: reply held only tokens the email gave');
            }
            // VIL-524. The judge is the gate on a find reply: a nearby-find ask, or a
            // turn whose tools handed over a find (any language). It does not edit the
            // draft. withhold, or a judge that failed, sends nothing. It reads the
            // draft with teen names already redacted, as the parent would (rule #1).
            const handedOverFind =
              offeredThisTurn.read().length > 0 || offeredThisTurn.links().length > 0;
            if (!noticeReady && (findTurn || handedOverFind)) {
              const gate = await ports.judgeFindReply(redactTeenNames(spoken, children, now));
              if (gate.verdict !== 'send') {
                console.error(
                  {
                    reason: gate.verdict === 'withhold' ? 'find_reasoning' : gate.reason,
                  },
                  'channel coach: find reply withheld - nothing sent',
                );
                await ports.recordRun(record('failed'));
                // A failed turn, not a deliberate silence (Devin #983): the router's
                // failed-turn path keeps the drafts receipt and the failed-turn ledger.
                // The withheld draft itself is never sent.
                throw failed(
                  gate.verdict === 'withhold'
                    ? 'channel coach: find reply withheld (find_reasoning)'
                    : `channel coach: find reply judge failed (${gate.reason})`,
                );
              }
            }
            // VIL-434: the model's answer goes out whole. Length is the model's judgment
            // (the skill, or a rewrite the model chooses). Code does not cut it, and it
            // does not call a shorten pass because a sentence ran past two segments.
            const reply = toSmsReply(spoken, {
              children,
              now,
              ...(noticeReady
                ? {}
                : {
                    planOffer: offer?.sentence,
                    referral: share ? referralBlock(share) : undefined,
                    activityLinks: turnLinks(),
                    nearby: nearby ?? undefined,
                  }),
            });
            await ports.recordRun(record('completed'));
            const card = experienceCard as ExperienceCardIntent | null;
            const capabilityNotes: CapabilityNotes | null =
              declined.length > 0 || corrected.length > 0 ? { declined, corrected } : null;
            return {
              reply,
              planOffer,
              activityPromise,
              spotWatch,
              capabilityNotes,
              // The title passes the same age-derived teen floor as the answer (rule #1).
              experienceCard:
                card && !noticeReady
                  ? { url: card.url, title: redactTeenNames(card.title, children, now) }
                  : null,
              groupLeave: groupLeave
                ? { ifLeaveFails: (groupLeave as GroupLeaveIntent).ifLeaveFails }
                : null,
              // A Gmail draft notice is a receipt to read, so it stays text.
              voiceMemo: voiceChosen && !noticeReady,
              draftedActionIds,
              emailRead: emailRead(),
            };
          } catch (err) {
            await undoAll();
            throw err;
          }
        },
      );
    },
  };
}

/** Null returns the same skill object. A turn without a .vcf does not grow the prompt. */
function augmentCoachSkillForContactCard(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return { ...skill, instructions: `${skill.instructions}\n\n${addendum.instructions}` };
/**
 * VIL-628 · what a reply written after read_email may repeat from this turn: the
 * parent's own words in this 1:1 and the app's own origin. Hale's earlier turns are not
 * on it, because an alert can quote the email, and neither is a rejected attempt's claim.
 * Nor is the family context: the provider watch and registration windows are read off
 * provider pages, and memory facts and the brief can be read off an email or a calendar.
 */
function trustedAfterEmail(turn: ChannelTurn, transcript: readonly TranscriptMessage[]): string[] {
  return [
    turn.body,
    ...transcript.filter((message) => message.role === 'user').map((message) => message.content),
    appBaseUrl(),
  ];
}

/** Enough for every fact a parent has told Hale; a fact past it is not trusted, so the
 * bound can only drop a token, never let one through. */
const PARENT_STATED_FACT_LIMIT = 500;

async function loadParentStatedFactValues(
  database: Database,
  familyId: string,
  parentUserId: string,
  now: Date,
): Promise<string[]> {
  const rows = await factsForContext(database, familyId, {
    now,
    reader: { adult: parentUserId },
    limit: PARENT_STATED_FACT_LIMIT,
  });
  return rows
    .filter((row) => row.memorySource === 'parent_message')
    .map((row) => JSON.stringify({ factKey: row.factKey, factValue: row.factValue }));
}

async function appendHouseholdGroupSkill(skill: Skill): Promise<Skill> {
  const group = await loadCronSkill('household-group');
  return { ...skill, instructions: `${skill.instructions}\n\n${group.instructions}` };
}

async function appendFactSourceSkill(skill: Skill): Promise<Skill> {
  const addendum = await loadCronSkill('coach-fact-source');
  return { ...skill, instructions: `${skill.instructions}\n\n${addendum.instructions}` };
}

async function appendGroupCoachSkill(skill: Skill): Promise<Skill> {
  const group = await loadCronSkill('coach-channel-group');
  return { ...skill, instructions: `${skill.instructions}\n\n${group.instructions}` };
}

let defaultClient: Anthropic | undefined;

function anthropicClient(): AgentClient {
  defaultClient ??= budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'coach' });
  return defaultClient;
}

/**
 * The production wiring: the one place the runtime meets real tables, the real skill
 * file, and the real reviewer. The draft port is bound to the SAME approval engine the
 * app's chips and the MCP proposals use, so a change asked for by text lands in the
 * queue indistinguishable from one asked for by tap (rule #3/#4/#6).
 */
export function productionChannelCoach(database: Database): ChannelCoachRuntime {
  return channelCoachRuntime(productionChannelCoachPorts(database));
}

/**
 * The ports themselves, exported so a test can drive the REAL ones. Two lines below —
 * the village tool's ledger callback and the add verb's read of it — are a pair that
 * compiles perfectly when either half is missing, and a fake port cannot fail on that.
 */
export function productionChannelCoachPorts(database: Database): ChannelCoachPorts {
  const findTurnReader = createFindTurnReader(anthropicClient);
  return {
    client: anthropicClient,
    readFindTurn: (input) => findTurnReader.read(input),
    judgeFindReply: (draft) => judgeWholeFindReply(anthropicClient, draft),
    experienceCardsEnabled: linqExperiencesEnabled,
    voiceMemosEnabled: linqVoiceMemosEnabled,
    photoFactsEnabled: inboundPhotoFactsEnabled,
    groupLeaveEnabled: linqGroupLeaveEnabled,
    groupLeaveCheck: (chatId) => groupLeaveEligibility({ chatId, explicitAsk: true }),
    emailReader: productionCoachEmailReader(database),
    loadSkill: async (parentUserId, familyId) =>
      augmentCoachSkillForStopWatching(
        augmentCoachSkillForSignupOffer(
          augmentCoachSkillForProviderWatch(
            augmentCoachSkillForAutonomySwitchOff(
              await augmentCoachSkillForGoogleDrafts(
                await loadCronSkill('coach-channel-sms'),
                parentUserId,
              ),
              await familyHasAutonomyGrant(familyId, database),
            ),
            browserUseWatchEnabled(),
          ),
          signupOfferToolEnabled(),
        ),
        (await loadParentLiveWatches(database, { familyId, parentUserId })).length > 0,
      ),
    loadTranscript: (conversationId) => loadTranscript(conversationId, database),
    loadContext: async (input) => {
      const context = await loadAgentContext(input, database);
      const householdGroup = await loadHouseholdGroupFact(database, input.familyId);
      return householdGroup ? { ...context, householdGroup } : context;
    },
    loadChildren: (familyId) => loadReplyChildren(database, familyId),
    // Optional data: a failed read leaves it out rather than failing the parent's turn.
    // The line names the fault class only.
    loadTimeZone: (familyId) => loadCoachTimeZone(database, familyId),
    loadForecast: (familyId) => loadCoachForecast(database, familyId),
    loadOwedCorrections: (familyId, parentUserId) =>
      loadOwedCorrections(database, { familyId, parentUserId }).catch((err: unknown) => {
        console.error(
          { fault: err instanceof Error ? err.name : typeof err },
          'coach: owed capability corrections unavailable',
        );
        return [];
      }),
    loadParentStatedFacts: (familyId, parentUserId, now) =>
      loadParentStatedFactValues(database, familyId, parentUserId, now),
    loadProviderWatch: (familyId, now) =>
      loadProviderWatchContext(database, familyId, now).catch((err: unknown) => {
        console.error(
          { fault: err instanceof Error ? err.name : typeof err },
          'coach: provider watch context unavailable',
        );
        return [];
      }),
    loadRegistrationWindows: (familyId, now) =>
      loadRegistrationWindows(
        productionRegistrationContextPorts(database),
        familyId,
        DEFAULT_TIMEZONE,
        now,
      ),
    buildTools: (
      turn,
      onDraft,
      onOffer,
      onShare,
      onPromise,
      onWatch,
      offered,
      onGmailNotice,
      onUndo,
      familyCountry,
    ) => {
      const listJournal = createGroupListJournal();
      const factReader: FactReader =
        turn.audience === 'group' ? 'every_adult' : { adult: turn.parentUserId };
      const listsLit = turn.audience === 'group' && groupSharedListsEnabled();
      if (listsLit && onUndo) {
        onUndo(() =>
          undoGroupListWrites(
            { database, actorUserId: turn.parentUserId, now: turn.now },
            listJournal,
          ),
        );
      }
      return buildChannelCoachTools({
        familyId: turn.familyId,
        familyCountry,
        reader: channelScheduleReader(database, turn.now),
        // VIL-443: a calendar_add drafted in the family group records that origin, so its
        // placement is reported back to the group. Code writes it; the model never sees it.
        draftPort: groupPlanDraftPort(
          productionChannelDraftPort(database, anthropicClient(), {
            now: turn.now,
            parentUserId: turn.parentUserId,
            origin: draftOriginForTurn(turn),
          }),
          turn,
          productionRecordGroupPlanOrigin(database),
        ),
        // The turn's offer ledger, written by the search verb and read by the add verb:
        // a placement should carry what placed it, and the process already holds the row.
        // Never shown to the model, which is the whole point.
        villageTool: searchVillageTool(database, offered.record),
        recordActivityLinks: offered.recordLinks,
        offeredThisTurn: offered.read,
        // The second activity source. Same key, same fail-closed resolver shape as the
        // loop's — a turn that could reach Anthropic for the loop and not for the search
        // is not a state worth being able to represent.
        activity: {
          reader: bindActivityReader(database, productionActivityFamilyReader(), factReader),
          // NOT the coach's client. A web-grounded search is a different job with a
          // different duration, and running it on the coach's 30s-plus-a-retry budget
          // meant the calls that needed forty seconds were killed twice before the lane
          // had its own go (see ACTIVITY_CLIENT_OPTIONS).
          finder: createActivityFinder(activityClient),
        },
        // The watch verb's three ports. `fetchBody` rather than `fetchPage`: a BookMe4
        // course keeps its availability in a <script> block the strip deletes, so a
        // watch armed off the stripped page could never see a spot open. The consent
        // port is the outbound gate's own, so a watch cannot be armed for a household
        // the gate would then refuse to text.
        spots: {
          fetchBody: createFetchBody(MINT_FETCH_TIMEOUT_MS),
          reader: bindActivityReader(database, productionActivityFamilyReader(), factReader),
          watchConsentGranted: buildOutboundGatePorts(database).watchConsentGranted,
          readClassAvailability: createLiveClassAvailabilityReader(
            anthropicClient(),
            MINT_FETCH_TIMEOUT_MS,
          ),
        },
        onDraft,
        onOffer,
        onShare,
        onPromise,
        onWatch,
        gmailDrafts: productionGmailDraftPorts(database, anthropicClient),
        onGmailNotice,
        spotRelease: {
          liveWatches: (scope) => loadParentLiveWatches(database, scope),
          release: (input) => releaseWatchByParent(database, { ...input, now: turn.now }),
        },
        autonomySwitchOff: {
          parentWords: turn.body,
          revoke: (input) =>
            revokeAutonomyForKind({ ...input, policyVersion: POLICY_VERSION }, database),
        },
        parentUserId: turn.parentUserId,
        now: turn.now,
        activitySignup: midActivitySignupToolEnabled()
          ? {
              database,
              familyId: turn.familyId,
              parentUserId: turn.parentUserId,
              now: turn.now,
              timeZone: () => channelScheduleReader(database, turn.now).timeZone(turn.familyId),
              offeredThisTurn: offered.read,
            }
          : null,
        groupLists: listsLit
          ? {
              database,
              familyId: turn.familyId,
              conversationId: turn.conversationId,
              actorUserId: turn.parentUserId,
              now: turn.now,
              journal: listJournal,
            }
          : null,
        providerWatch: browserUseWatchEnabled()
          ? {
              database,
              familyId: turn.familyId,
              parentUserId: turn.parentUserId,
              conversationId: turn.conversationId,
              parentWords: turn.body,
              linksThisTurn: () => [
                ...offered.links(),
                ...offered
                  .read()
                  .flatMap((item) => (item.url ? [{ title: item.title, url: item.url }] : [])),
                ...photoFactSignupLinks(turn.photoFacts),
              ],
            }
          : null,
        signupOffer: signupOfferToolEnabled()
          ? {
              database,
              familyId: turn.familyId,
              parentUserId: turn.parentUserId,
              now: turn.now,
              parentWords: turn.body,
              linksThisTurn: () => [
                ...offered.links(),
                ...offered
                  .read()
                  .flatMap((item) => (item.url ? [{ title: item.title, url: item.url }] : [])),
                ...photoFactSignupLinks(turn.photoFacts),
              ],
            }
          : null,
      });
    },
    nearbySaid: (familyId, offers) => nearbySaidFor(database, familyId, offers),
    guardDeps: buildGuardDeps(database),
    runAgent,
    recordRun: async (run) => {
      await recordAgentRun(database, {
        familyId: run.familyId,
        agentName: run.agentName,
        modelUsed: pickModel('converse'),
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        costUsd: run.costUsd,
        latencyMs: run.latencyMs,
        promptCacheHit: run.promptCacheHit,
        cacheReadTokens: run.cacheReadTokens,
        cacheWriteTokens: run.cacheWriteTokens,
        status: run.status,
        langfuseTraceId: run.langfuseTraceId,
      });
    },
    now: () => new Date(),
    // VIL-495: a voice memo is heard only while the flag is lit, and only on a 1:1 turn.
    // VIL-413: a PDF is fetched only while inbound photo facts are lit.
    readInboundMedia: (parts, audience) =>
      readInboundMedia(
        parts,
        fetch,
        audience === 'direct' && linqVoiceMemosEnabled()
          ? (part) => hearVoiceMemo(part, audience)
          : undefined,
        inboundPhotoFactsEnabled() ? { documents: true } : undefined,
      ),
    readPhotoFacts: (input) => extractInboundPhotoFacts({ ...input, client: anthropicClient() }),
  };
}

async function photoFactsForTurn(
  turn: ChannelTurn,
  ports: ChannelCoachPorts,
  blocks: Anthropic.ContentBlockParam[],
  now: Date,
  timeZone: string | null,
): Promise<PhotoFacts | null> {
  const lit = ports.photoFactsEnabled?.() ?? inboundPhotoFactsEnabled();
  if (!lit || blocks.length === 0) return null;
  if (!ports.readPhotoFacts) {
    console.info({ reason: 'not_configured' }, 'channel coach: inbound photo facts unread');
    return null;
  }
  try {
    return await ports.readPhotoFacts({
      blocks,
      parentWords: turn.body,
      now,
      timeZone,
      audience: turn.audience,
    });
  } catch (err) {
    console.info(
      { reason: 'extract_failed', err: err instanceof Error ? err.name : 'unknown' },
      'channel coach: inbound photo facts unread',
    );
    return null;
  }
}

async function mediaForTurn(
  turn: ChannelTurn,
  ports: ChannelCoachPorts,
): Promise<ReadInboundMedia> {
  const parts = turn.inboundMedia ?? [];
  if (parts.length === 0) {
    return { blocks: [], unwatched: [], contacts: [], contactsTruncated: false };
  }
  if (!ports.readInboundMedia) {
    console.info(
      { reason: 'not_configured', count: parts.length },
      'channel coach: inbound media unread',
    );
    return {
      blocks: [],
      unwatched: parts.map((part) => ({ kind: part.kind })),
      contacts: [],
      contactsTruncated: false,
    };
  }
  return ports.readInboundMedia(parts, turn.audience);
}

async function loadReplyChildren(database: Database, familyId: string): Promise<ReplyChild[]> {
  return database
    .select({
      name: schema.children.name,
      gender: schema.children.gender,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
}

/**
 * The production `nearbySaid`: the surface flag, the family's area, one indexed scan,
 * and the pure gate.
 *
 * IT FAILS CLOSED AT EVERY STEP and silence is always an acceptable answer — the flag is
 * off for months by design, a household with no FSA-shaped area has no "near you", and an
 * offer with no shared identity has nothing to pool on.
 */
export async function nearbySaidFor(
  database: Database,
  familyId: string,
  offers: readonly OfferedCandidate[],
): Promise<{ clause: string; title: string; otherTitles: string[] } | null> {
  if (!activityReviewsSurfaceEnabled()) return null;
  if (offers.length === 0) return null;
  const subjects = offers
    .map(offeredSubject)
    .filter((subject): subject is NonNullable<typeof subject> => subject !== null);
  if (subjects.length === 0) return null;
  const areaKey = await familyAreaKey(database, familyId);
  if (areaKey === null) return null;
  const verdicts = await readSubjectVerdicts(database, subjects, areaKey);
  return nearbyClauseTarget(offers, verdicts);
}
