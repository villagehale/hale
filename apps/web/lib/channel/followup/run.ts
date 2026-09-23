import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import {
  type DaycareSubject,
  type WeekdayCareFact,
  loadDaycareSubjects,
  loadWeekdayCare,
  weekdayCareEnabled,
} from '~/lib/care/weekday';
import {
  ACTIVITY_FOLLOWUP_ASK_TEMPLATE_KEY,
  activityFollowupAskDedupeKey,
} from '~/lib/channel/followup/ask-open';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { type SendRefusalReason, refuseUnbackedSend } from '~/lib/channel/reconcile/gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { readDueBookings } from '~/lib/integrations/booking';
import { isPrivateEvent } from '~/lib/loop/templates/reminder/core';
import type { ReminderChild } from '~/lib/loop/templates/reminder/payload';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { discoverableUserIds } from '~/lib/village/intros/consent';
import { inboundSince, mentionsActivity, mentionsDaycare, mentionsIntro } from './screen';
import {
  type ComposeDeferral,
  type FollowupVoice,
  type FollowupVoiceRequest,
  createFollowupVoice,
  lockedActivityFollowup,
} from './voice';

/**
 * THE FOLLOW-UP ASK — Hale checks back on the things it set up.
 *
 * Founder directive, 2026-08-12: after Hale introduces two families, or a family attends
 * an activity Hale placed, Hale asks how it went. What the parent says flows into memory.
 *
 * DERIVED BY QUERY, NOT MINTED. There is no follow-up table, no scheduled row, and no new
 * write path anywhere upstream. A follow-up is due when rows that ALREADY EXIST say so —
 * an intro pair that closed as `both_accepted` three days ago, a `source='placement'`
 * event whose start time passed yesterday — and the only thing this sweep writes is the
 * send itself. That is what makes the feature reversible: turn the flag off and there is
 * nothing left over, no ledger to drain, no orphaned jobs, no half-state to migrate.
 *
 * THE SEND IS THE CLAIM. `channel_messages.dedupe_key` is unique where present, so the
 * row that records the text is also the fact that stops the next hourly tick re-sending
 * it. No separate claim table and no "asked" boolean to keep in step with reality — the
 * question "have we asked yet?" has exactly one reader, and it reads the same row a
 * PIPEDA right-to-access request would.
 *
 * THE REPLY IS NOT HANDLED HERE, and there is deliberately no handler anywhere. A parent
 * who answers "we did, they were lovely" is just texting Hale, and that text goes down
 * the router into the coach exactly like any other, where the coach's memory tools
 * persist what they said. Zero new inbound surface is the point of the feature, not a
 * shortcut in it: a bespoke reply parser would be a second grammar competing with the
 * router's, and every message it claimed would be a message the coach never saw.
 *
 * WHY A STAGE ON THE NUDGE CRON. Same reason the intro sweep rides it (see
 * village/intros/run.ts): the hourly cadence already exists, and the question — may Hale
 * interrupt this parent right now, and with what — is the one that cron exists to ask.
 */

export const FOLLOWUP_ASKS_ENABLED_ENV = 'FOLLOWUP_ASKS_ENABLED';
export const FOLLOWUP_ASKS_ALLOWLIST_ENV = 'FOLLOWUP_ASKS_FAMILY_ALLOWLIST';

/**
 * Its OWN dark-launch flag, not F14's and not the intros'.
 *
 * STRICT equality on the literal 'true': `vercel env add` from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'`, and a
 * truthiness check reads that as ON.
 */
export function followupAsksEnabled(): boolean {
  return process.env[FOLLOWUP_ASKS_ENABLED_ENV] === 'true';
}

export function followupAsksAllowlist(): Set<string> {
  return new Set(
    (process.env[FOLLOWUP_ASKS_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/**
 * THE WINDOWS — how soon a follow-up may go, and how late it may still be worth sending.
 *
 * Three days after the introduction email: soon enough that "did you connect" is a live
 * question, late enough that a weekend has had a chance to happen. Five is where it stops
 * being a check-in and starts being an audit of something the family has moved on from.
 *
 * A day after a placed activity, so the ask lands the morning after rather than while the
 * family is still in the car; four, because the ask has to survive quiet hours, the
 * one-a-day rail, and however many recomposes the voice needs, and every one of those can
 * cost it a tick.
 *
 * THE CEILINGS ARE STRUCTURAL, not editorial. Without one, the first tick after this
 * ships would text every family ever introduced, however long ago, because none of them
 * carries a claim yet — a query-derived feature's version of a migration backfire.
 */
export const INTRO_FOLLOWUP_MIN_AGE_DAYS = 3;
export const INTRO_FOLLOWUP_MAX_AGE_DAYS = 5;
export const ACTIVITY_FOLLOWUP_MIN_AGE_DAYS = 1;
export const ACTIVITY_FOLLOWUP_MAX_AGE_DAYS = 4;

/**
 * VIL-360 · three days after a parent said their child is at daycare, and ten at the
 * outside. Three because the first week is the one worth asking about and a day or two
 * in is too soon to have an answer; ten because past that "how is it going?" is an
 * audit of something the family has settled into.
 *
 * WIDER THAN THE OTHER TWO on purpose: this window has no event in it. An intro and an
 * activity both happened at an instant, and the ask is about that instant; a child
 * starting daycare is a fortnight, and there is no day inside it that is the right day.
 */
export const DAYCARE_FOLLOWUP_MIN_AGE_DAYS = 3;
export const DAYCARE_FOLLOWUP_MAX_AGE_DAYS = 10;

/** One per child, forever — the row that both stops the next tick and answers "have we
 * asked?" for a PIPEDA request. */
export const DAYCARE_FOLLOWUP_TEMPLATE_KEY = 'followup:daycare';
export function daycareFollowupDedupeKey(childId: string): string {
  return `${DAYCARE_FOLLOWUP_TEMPLATE_KEY}:${childId}`;
}

/**
 * How far PAST its ceiling a row is still selected, so that aging out is something the
 * sweep observes rather than something that happens to it.
 *
 * A row that simply stopped matching would be a follow-up Hale decided not to send and
 * never said so — the silent skip rule #11 exists to forbid. One hour is one tick of the
 * cron this rides, so a row lands in the grace band on exactly one sweep and is counted
 * as `window_passed` exactly once. A tick that does not run loses the COUNT, never the
 * behaviour: the ask was already never going out.
 */
const WINDOW_GRACE_HOURS = 1;

const DAY_MS = 24 * 3_600_000;

/** Filter first, then cap — a cap-then-filter would starve every family past the
 * oldest N forever. */
const MAX_FAMILIES_PER_RUN = 200;

/** An intro is a PAIR: both sides are asked, or neither is. The skip counters count
 * unasked SIDES, so a pair-level refusal costs two. */
const SIDES_PER_INTRO = 2;

/**
 * The band of anchor instants a follow-up is due for, expressed as instants so the SQL
 * predicate and the intent share one arithmetic.
 *
 * `latest` is the NEWEST anchor old enough to ask about and `earliest` the OLDEST still
 * worth asking about, so an eligible row's anchor sits between them. `floor` is how far
 * back the QUERY reaches — one grace tick past `earliest` — and a row between `floor` and
 * `earliest` is one that has just aged out: selected so it can be counted, never sent.
 */
export interface FollowupWindow {
  floor: Date;
  earliest: Date;
  latest: Date;
}

function windowOf(now: Date, minAgeDays: number, maxAgeDays: number): FollowupWindow {
  const earliest = new Date(now.getTime() - maxAgeDays * DAY_MS);
  return {
    floor: new Date(earliest.getTime() - WINDOW_GRACE_HOURS * 3_600_000),
    earliest,
    latest: new Date(now.getTime() - minAgeDays * DAY_MS),
  };
}

export function introFollowupWindow(now: Date): FollowupWindow {
  return windowOf(now, INTRO_FOLLOWUP_MIN_AGE_DAYS, INTRO_FOLLOWUP_MAX_AGE_DAYS);
}

export function activityFollowupWindow(now: Date): FollowupWindow {
  return windowOf(now, ACTIVITY_FOLLOWUP_MIN_AGE_DAYS, ACTIVITY_FOLLOWUP_MAX_AGE_DAYS);
}

export function daycareFollowupWindow(now: Date): FollowupWindow {
  return windowOf(now, DAYCARE_FOLLOWUP_MIN_AGE_DAYS, DAYCARE_FOLLOWUP_MAX_AGE_DAYS);
}

export interface FollowupFamily {
  familyId: string;
  parentUserId: string;
}

/** An introduction that happened, old enough to ask about. */
export interface DueIntro {
  proposalId: string;
  familyAId: string;
  familyBId: string;
  /** When the introduction email went — the window anchor, and the instant the
   * told-anywhere screen reads a family's own words forward from. */
  introducedAt: Date;
}

/**
 * Something that happened, old enough to ask about. Carries exactly the fields
 * `isPrivateEvent` reads, plus the title the ask renders and the parent it goes to.
 *
 * `ref` rather than a bare `eventId`, mirroring `CorrelatedEventRef`, because there are
 * now two sources: a calendar row Hale PLACED, and a booking a provider CONFIRMED. The
 * dedupe key and the audit row both key on it, and uuids do not collide across tables, so
 * a placement's key is byte-identical to what it was before this union existed.
 *
 * `parentUserId` IS THE ITEM'S, NEVER THE FAMILY'S, and that is the whole reason it is on
 * this interface. The alert texts the CONNECTING user (`integrations.user_id`) and the
 * offer is answerable only by them, but this sweep used to send to the family's
 * `primary_parent`: co-parent B's Gmail would have produced a question on primary parent
 * A's phone, one to four days after a class A may not know B registered for. Neither
 * parent consented to that crossing (rule #5, D13), and Hale's own doctrine — ask about
 * what it SAW — says it saw this in B's mailbox. Any future reader added to the union
 * that returns `family.parentUserId` re-opens it silently.
 */
export interface DueActivity {
  ref: { table: 'family_events' | 'activity_bookings'; id: string };
  familyId: string;
  parentUserId: string;
  title: string;
  startsAt: Date;
  childId: string | null;
  sensitive: boolean;
}

/**
 * Why a follow-up Hale could have sent did not go — the reasons that are this sweep's
 * own, as opposed to the four the outbound gate owns (rule #11: a skipped send is a
 * named outcome, never a silent `continue`).
 *
 * Counted per SIDE that went unasked, not per pair, so the numbers read as "texts not
 * sent" and line up with `introAsked` / `activityAsked`.
 */
export type FollowupSkipReason =
  | 'opted_out'
  | 'already_claimed'
  /** The parent already told us, in their own words, since it happened. */
  | 'already_discussed'
  | 'private_item'
  | 'out_of_scope'
  /** Never asked before the moment passed. The one outcome here that is a small failure
   * rather than a correct refusal, which is exactly why it is counted. */
  | 'window_passed'
  /**
   * VIL-360 · the answer was SUPERSEDED between the window opening and the tick — the
   * parent said daycare on Monday and "she's home again" on Thursday, or named a
   * different place. A CORRECT refusal, and its own reason rather than a silent skip:
   * "how is daycare going?" to a household that has just told Hale it is not — or that
   * names the place their child LEFT — is the worst message this lane could send.
   */
  | 'care_changed';

export interface FollowupAudit {
  familyId: string;
  actor: string;
  actionTaken: string;
  targetTable: string;
  targetId: string;
  after: Record<string, unknown>;
}

export interface FollowupSweepDeps {
  selectFamilies(database: Database, now: Date): Promise<FollowupFamily[]>;
  loadDueIntros(database: Database, now: Date): Promise<DueIntro[]>;
  /** Which of these parents are still discoverable — the intros opt-in, read
   * latest-row-wins. Reused verbatim from the intros lane so the two can never disagree
   * about what "opted out" means. */
  discoverableUserIds(database: Database, userIds: readonly string[]): Promise<Set<string>>;
  /** THE FAMILY, not just its id: a placement's parent is the household's primary and a
   * booking's is the mailbox the receipt arrived in, so the reader needs both to answer
   * (rule #5). */
  loadDueActivities(database: Database, family: FollowupFamily, now: Date): Promise<DueActivity[]>;
  /**
   * VIL-360 · the daycare answers this family gave inside the window, SUPERSEDED ONES
   * INCLUDED, and the live picture to compare them against.
   *
   * Two readers rather than one, because they answer two different questions: "is there
   * something to ask about" and "is it still the live row". Folding them would make
   * `care_changed` unobservable, which is the one refusal this stage exists to be able
   * to name (rule #11). The comparison is on the fact's ID, not its care value, which
   * is why the live reader hands back `factId`.
   */
  loadDaycareSubjects(
    database: Database,
    familyId: string,
    window: { floor: Date; latest: Date },
  ): Promise<DaycareSubject[]>;
  loadWeekdayCare(database: Database, familyId: string): Promise<WeekdayCareFact[]>;
  loadChildren(database: Database, familyId: string): Promise<ReminderChild[]>;
  /** The family's own inbound messages since an instant, lowercased — what the
   * told-anywhere screen reads. */
  loadInboundSince(database: Database, familyId: string, since: Date): Promise<string[]>;
  buildGate(database: Database): OutboundGatePorts;
  /** The reconciliation primitive's send-boundary gate (VIL-293). REQUIRED (rule #11):
   * a lane that could silently skip it would send exactly the claims it exists to stop. */
  refuseUnbackedSend: typeof refuseUnbackedSend;
  dedupeActive(database: Database, dedupeKey: string): Promise<boolean>;
  resolveSendablePhone(database: Database, parentUserId: string): Promise<string | null>;
  recordSend(
    database: Database,
    write: {
      familyId: string;
      parentUserId: string;
      templateKey: string;
      dedupeKey: string;
      providerMessageId: string;
      sentAt: Date;
    },
  ): Promise<string>;
  audit(database: Database, row: FollowupAudit): Promise<void>;
  /** REQUIRED (rule #11). A sweep that can decide to ask and quietly fail to ask is a
   * sweep whose counters lie. */
  transport: ChannelTransport;
  /** REQUIRED, and the ONLY source of the words in a follow-up. There is no fixed line
   * behind it (founder doctrine: no preset bodies), so a sweep without a voice does not
   * send a duller message — it sends nothing, visibly. */
  voice: FollowupVoice;
  /**
   * Put the sent ask in the parent's own text thread — REQUIRED, same reason as the two
   * above (rule #11). Every message this sweep sends is a QUESTION, and the answer to it
   * comes back as a coach turn; `channel_messages` carries no body (rule #1), so an ask
   * that skips this is one the coach reads a reply to with nothing above it. There is no
   * "no thread" to express: the anchor derives from the family and parent ids
   * (lib/channel/thread.ts).
   */
  threadMessage: typeof threadProactiveMessage;
}

export interface FollowupSweepResult {
  /** False when neither the flag nor the allowlist armed the sweep. */
  enabled: boolean;
  introAsked: number;
  activityAsked: number;
  daycareAsked: number;
  /**
   * Asks the voice could not compose this tick. Its own field rather than a `skipped`
   * entry because it is the only outcome here that is neither a refusal nor a send: the
   * claim is unspent, the window is still open, and the next tick tries again. Counting
   * it beside the two send counters is what makes "how often does Hale have nothing to
   * say" a number somebody can watch.
   */
  composeDeferred: number;
  /**
   * Asks whose composed body claimed a row that does not exist, refused at the send
   * boundary (VIL-293). Its own field for the reason `composeDeferred` is one: it is
   * neither a refusal by policy nor a model having nothing to say — it is a sentence
   * that WAS composed, was about to go out, and asserted something untrue. A non-zero
   * here is the voice inventing state, and that must never read as a quiet tick.
   */
  refusedAtSend: number;
  held: Record<ProactiveHoldReason, number>;
  skipped: Record<FollowupSkipReason, number>;
  failed: number;
}

function emptyResult(enabled: boolean): FollowupSweepResult {
  return {
    enabled,
    introAsked: 0,
    activityAsked: 0,
    daycareAsked: 0,
    composeDeferred: 0,
    refusedAtSend: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    skipped: {
      opted_out: 0,
      already_claimed: 0,
      already_discussed: 0,
      private_item: 0,
      out_of_scope: 0,
      window_passed: 0,
      care_changed: 0,
    },
    failed: 0,
  };
}

type SendOutcome =
  | { status: 'sent' }
  | { status: 'held'; reason: ProactiveHoldReason }
  | { status: 'already_claimed' }
  | { status: 'already_discussed' }
  | { status: 'compose_deferred'; reason: ComposeDeferral }
  | { status: 'refused_at_send'; reasons: readonly SendRefusalReason[] };

/**
 * The ONE way this feature reaches a phone. Five preconditions, in this order, and the
 * order is the design — each step is cheaper than the one after it and decisive on its
 * own, so nothing expensive is ever spent on a message that was never going out:
 *
 *   1. CLAIMED?    one indexed read      — have we already asked this exact thing?
 *   2. DISCUSSED?  one scan of what they said — did they already tell us?
 *   3. ALLOWED?    the outbound gate's four reads about the family
 *   4. COMPOSED?   the model call, the only step that costs money
 *   5. SEND + LEDGER
 *
 * THE CLAIM CHECK RUNS FIRST, where the intro sweep runs its gate first, and the
 * departure is deliberate: with a one-per-family-per-day budget, a gate-first order
 * reports an already-sent follow-up as `frequency_cap` — the message's own prior send
 * blocking itself — and hides that idempotency, not policy, is what stopped it.
 *
 * THE COMPOSE RUNS LAST, and a deferral from it writes NOTHING. That is the whole
 * contract behind having no canned fallback: the claim stays unspent, the window stays
 * open, and the next tick composes again.
 */
async function sendFollowup(
  database: Database,
  deps: FollowupSweepDeps,
  input: {
    familyId: string;
    parentUserId: string;
    ask: FollowupVoiceRequest;
    /** Lazy on purpose: a claimed message must not pay for a scan of the family's
     * messages to find out it was already claimed. */
    alreadyDiscussed: () => Promise<boolean>;
    templateKey: string;
    dedupeKey: string;
    now: Date;
  },
): Promise<SendOutcome> {
  if (await deps.dedupeActive(database, input.dedupeKey)) return { status: 'already_claimed' };
  if (await input.alreadyDiscussed()) return { status: 'already_discussed' };

  const verdict = await assertProactiveSendAllowed(
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      kind: 'followup',
      now: input.now,
    },
    deps.buildGate(database),
  );
  if (!verdict.allowed) return { status: 'held', reason: verdict.reason };

  const composed =
    input.ask.kind === 'activity'
      ? lockedActivityFollowup(input.ask.activity)
      : await deps.voice.compose(input.ask);
  if (composed.status === 'deferred') {
    return { status: 'compose_deferred', reason: composed.reason };
  }

  const to = await deps.resolveSendablePhone(database, input.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`followup asks: no send target for parent ${input.parentUserId}`);
  }

  // THE GATE, ON THE STRING THAT ACTUALLY LEAVES (VIL-293) — after `withOptOut`, because
  // everything between a gate and the transport is unchecked by construction and this
  // lane appends a CASL line past its composer. A follow-up ASK claims nothing by design,
  // so an empty answer is the ordinary one and costs no query; a non-empty one means the
  // voice wrote a sentence about a row that is not there, and the claim stays unspent for
  // the next tick rather than the sentence being trimmed.
  const body = withOptOut(composed.body, verdict.optOut);
  const unbacked = await deps.refuseUnbackedSend(database, {
    familyId: input.familyId,
    body,
    now: input.now,
  });
  if (unbacked.length > 0) {
    console.error(
      { familyId: input.familyId, templateKey: input.templateKey, reasons: unbacked },
      'followup asks: the wire body claims a row that does not exist - refused at the send boundary',
    );
    return { status: 'refused_at_send', reasons: unbacked };
  }

  const { providerMessageId } = await deps.transport.send({ to, body });
  await deps.recordSend(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    templateKey: input.templateKey,
    dedupeKey: input.dedupeKey,
    providerMessageId,
    sentAt: input.now,
  });
  // THE THREAD, which is where the answer to this question will be read. AFTER the send
  // and unconditional: a compose that never reached a transport asked nobody anything.
  // The COMPOSED ask, never the wire body — the CASL line belongs on the wire alone.
  await deps.threadMessage(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    body: composed.body,
  });
  return { status: 'sent' };
}

/** Fold one send's outcome into the run's counters. Returns whether it went. */
function tally(result: FollowupSweepResult, outcome: SendOutcome): boolean {
  switch (outcome.status) {
    case 'sent':
      return true;
    case 'held':
      result.held[outcome.reason] += 1;
      return false;
    case 'compose_deferred':
      result.composeDeferred += 1;
      return false;
    case 'refused_at_send':
      result.refusedAtSend += 1;
      return false;
    default:
      result.skipped[outcome.status] += 1;
      return false;
  }
}

/**
 * Stage 1 — "did you end up connecting?", three days after an introduction.
 *
 * THE PAIR IS THE UNIT: both sides are asked, or neither is. A pair where one household
 * has withdrawn — opted out of intros, left the SMS surface, or fallen outside this
 * run's scope — gets no follow-up at all, including to the side that is still here.
 * Asking the remaining parent how it went would be Hale nudging them toward a household
 * that has stepped back, on the strength of a connection the other side no longer wants
 * Hale in the middle of.
 *
 * IT RUNS BEFORE THE ACTIVITY STAGE, and that ordering is the whole of "intro wins".
 * The day's single slot in PROACTIVE_CAP goes to whoever asks first.
 */
async function runIntroFollowups(
  database: Database,
  deps: FollowupSweepDeps,
  byId: ReadonlyMap<string, FollowupFamily>,
  result: FollowupSweepResult,
  now: Date,
): Promise<void> {
  const due = await deps.loadDueIntros(database, now);
  if (due.length === 0) return;

  const parentIds = [...byId.values()].map((family) => family.parentUserId);
  const discoverable = await deps.discoverableUserIds(database, parentIds);
  const window = introFollowupWindow(now);

  for (const intro of due) {
    try {
      if (intro.introducedAt < window.earliest) {
        result.skipped.window_passed += SIDES_PER_INTRO;
        continue;
      }

      const familyA = byId.get(intro.familyAId);
      const familyB = byId.get(intro.familyBId);
      if (!familyA || !familyB) {
        result.skipped.out_of_scope += SIDES_PER_INTRO;
        continue;
      }

      const sides = [
        { key: 'a', family: familyA },
        { key: 'b', family: familyB },
      ] as const;
      if (sides.some((side) => !discoverable.has(side.family.parentUserId))) {
        result.skipped.opted_out += sides.length;
        continue;
      }

      for (const side of sides) {
        const outcome = await sendFollowup(database, deps, {
          familyId: side.family.familyId,
          parentUserId: side.family.parentUserId,
          ask: { kind: 'intro' },
          alreadyDiscussed: async () =>
            mentionsIntro(
              await deps.loadInboundSince(database, side.family.familyId, intro.introducedAt),
            ),
          templateKey: 'followup:intro',
          dedupeKey: `followup:intro:${intro.proposalId}:${side.key}`,
          now,
        });
        if (!tally(result, outcome)) continue;

        result.introAsked += 1;
        await deps.audit(database, {
          familyId: side.family.familyId,
          actor: 'system',
          actionTaken: 'followup_intro_asked',
          targetTable: 'village_intro_proposals',
          targetId: intro.proposalId,
          // Which side, and nothing else. The counterpart is already named on the
          // `village_intro_disclosed` row this one points at; repeating it here would
          // widen the trail without answering a question it cannot already answer.
          after: { side: side.key },
        });
      }
    } catch (err) {
      result.failed += 1;
      console.error({ err, proposalId: intro.proposalId }, 'followup asks: intro ask failed');
    }
  }
}

/**
 * Stage 2 — "how was {title}?", the day after something Hale put on the calendar.
 *
 * A PRIVATE ITEM GETS NO FOLLOW-UP AT ALL, rather than a genericized one. The reminders
 * engine genericizes ("an appointment") because a reminder still has a job to do when it
 * cannot say what the thing is — the parent needs to be somewhere. A follow-up has no
 * such job: "how was an appointment?" is unanswerable AND it discloses that something
 * private happened, which for a 13+ child is Hale volunteering the existence of their
 * calendar to a parent, unprompted (rule #1). Dropping it is both simpler and stricter,
 * and it reuses the reminders engine's own {@link isPrivateEvent} predicate so the two
 * surfaces can never disagree about which items those are.
 *
 * Oldest first: with one slot a day, the item closest to falling out of its window is
 * the one worth spending it on.
 */
async function runActivityFollowups(
  database: Database,
  deps: FollowupSweepDeps,
  families: readonly FollowupFamily[],
  result: FollowupSweepResult,
  now: Date,
): Promise<void> {
  const window = activityFollowupWindow(now);

  for (const family of families) {
    try {
      const due = await deps.loadDueActivities(database, family, now);
      if (due.length === 0) continue;
      const children = await deps.loadChildren(database, family.familyId);

      for (const event of due) {
        if (event.startsAt < window.earliest) {
          result.skipped.window_passed += 1;
          continue;
        }

        const isPrivate = isPrivateEvent(
          { childId: event.childId, sensitive: event.sensitive },
          children,
          now,
        );
        if (isPrivate) {
          result.skipped.private_item += 1;
          continue;
        }

        const outcome = await sendFollowup(database, deps, {
          familyId: family.familyId,
          // THE ITEM'S OWN PARENT, never the family's primary. See DueActivity.
          parentUserId: event.parentUserId,
          ask: { kind: 'activity', activity: event.title },
          // Anchored at the event's own start, so the scan asks "did they say anything
          // about this SINCE it happened" — a mention from before it is a plan, not a
          // report, and suppressing on one would drop the follow-up for every activity
          // the family had ever discussed.
          //
          // FAMILY-SCOPED ON PURPOSE, even though the send is now per-parent: for a
          // co-parent's booking, the primary parent's words can suppress the ask. That is
          // the correct direction — this screen can only ever send FEWER texts, and the
          // messages are family-scoped in the ledger already. A "fix" to a per-parent read
          // would start asking twice.
          alreadyDiscussed: async () =>
            mentionsActivity(
              await deps.loadInboundSince(database, family.familyId, event.startsAt),
              event.title,
            ),
          templateKey: ACTIVITY_FOLLOWUP_ASK_TEMPLATE_KEY,
          // BYTE-IDENTICAL for a placement, where `ref.id` IS the event id: nothing
          // already claimed is re-asked across this refactor. A booking's key is its own
          // uuid, and uuids do not collide across tables, so the key space needs no
          // prefix — and the review capture that reads this key back resolves a booking
          // id against `family_events`, finds nothing, and counts `no_placing_action`
          // before any model sees a word.
          dedupeKey: activityFollowupAskDedupeKey(event.ref.id),
          now,
        });
        if (!tally(result, outcome)) continue;

        result.activityAsked += 1;
        await deps.audit(database, {
          familyId: family.familyId,
          actor: 'system',
          actionTaken: 'followup_activity_asked',
          targetTable: event.ref.table,
          targetId: event.ref.id,
          // The title is NOT recorded. It is family calendar content, the audit row
          // already points at the row that holds it, and a trail that copies content
          // is a second place to leak it from (rule #1).
          after: { startsAt: event.startsAt.toISOString() },
        });
      }
    } catch (err) {
      result.failed += 1;
      console.error({ err, familyId: family.familyId }, 'followup asks: activity ask failed');
    }
  }
}

/**
 * Stage 3 — "how is it going?", days after a parent said their child had started
 * daycare (VIL-360).
 *
 * ONCE PER CHILD, EVER. The dedupe key carries no date and no window, so the row that
 * records the send is also the permanent answer to "have we asked?" — a recurring
 * version of this would be a survey rather than a check-in (founder decision #4).
 *
 * IT RUNS LAST, so the day's single slot goes to the intro and the activity first. Both
 * of those are about something that happened on a day and stop being worth asking
 * about; this one is about a fortnight and tolerates a tick's wait.
 *
 * ITS OWN FLAG on top of the sweep's, because this is the weekday-care feature's leg
 * rather than the follow-up lane's: turning WEEKDAY_CARE_ENABLED off stops it being due
 * and leaves nothing behind.
 *
 * THE ASK GOES TO ONE SEAT, and that asymmetry is named rather than accidental: the
 * nudge that asked the question reached both parents, and this reaches the primary one.
 * It is correct here for once — the parent who answered is the one holding the context —
 * but it is a residual, because `FollowupFamily` cannot express "the parent who
 * answered".
 */
async function runDaycareFollowups(
  database: Database,
  deps: FollowupSweepDeps,
  families: readonly FollowupFamily[],
  result: FollowupSweepResult,
  now: Date,
): Promise<void> {
  if (!weekdayCareEnabled()) return;
  const window = daycareFollowupWindow(now);

  for (const family of families) {
    try {
      const subjects = await deps.loadDaycareSubjects(database, family.familyId, window);
      if (subjects.length === 0) continue;
      const live = new Map(
        (await deps.loadWeekdayCare(database, family.familyId)).map((fact) => [
          fact.childId,
          fact.factId,
        ]),
      );

      for (const subject of subjects) {
        if (subject.validFrom < window.earliest) {
          result.skipped.window_passed += 1;
          continue;
        }
        // THE SUBJECT IS SUPERSEDED WHEN THE LIVE ROW IS A DIFFERENT ROW, not when its
        // word changed. `loadDaycareSubjects` deliberately returns superseded answers
        // so this refusal can be counted, and a family that MOVES daycare has said
        // `daycare` twice - so a comparison on the care value saw no change and asked
        // "How is Little Sprouts going?" about the place the parent had just said their
        // child left, spending the once-per-child key on it forever. Identity settles
        // it, and it subsumes the home case: a `home` row is a different row too.
        //
        // The newer answer is not asked about HERE - its own window has not opened yet.
        // It opens three days after the parent gave it, with the key still unspent.
        if (live.get(subject.childId) !== subject.factId) {
          result.skipped.care_changed += 1;
          continue;
        }

        const outcome = await sendFollowup(database, deps, {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          ask: { kind: 'daycare', provider: subject.provider },
          // Anchored just PAST the moment they told Hale, and the millisecond is
          // load-bearing rather than defensive: the message that created this subject
          // is the one that said "she's at Little Sprouts", and `inboundSince` is
          // inclusive - so an anchor at `validFrom` screens the ask against the
          // sentence that earned it, and the follow-up never goes to anybody.
          alreadyDiscussed: async () =>
            mentionsDaycare(
              await deps.loadInboundSince(
                database,
                family.familyId,
                new Date(subject.validFrom.getTime() + 1),
              ),
              subject.provider,
            ),
          templateKey: DAYCARE_FOLLOWUP_TEMPLATE_KEY,
          dedupeKey: daycareFollowupDedupeKey(subject.childId),
          now,
        });
        if (!tally(result, outcome)) continue;

        result.daycareAsked += 1;
        await deps.audit(database, {
          familyId: family.familyId,
          actor: 'system',
          actionTaken: 'followup_daycare_asked',
          targetTable: 'family_memory_facts',
          targetId: subject.factId,
          // Never the provider and never the child: the row this points at holds both,
          // and a trail that copies content is a second place to leak it from (rule #1).
          after: { askedAt: now.toISOString() },
        });
      }
    } catch (err) {
      result.failed += 1;
      console.error({ err, familyId: family.familyId }, 'followup asks: daycare ask failed');
    }
  }
}

export async function runFollowupSweep(
  database: Database,
  deps: FollowupSweepDeps = defaultFollowupSweepDeps(),
  now: Date = new Date(),
): Promise<FollowupSweepResult> {
  const allFamilies = followupAsksEnabled();
  const allowlist = followupAsksAllowlist();
  if (!allFamilies && allowlist.size === 0) return emptyResult(false);

  const result = emptyResult(true);
  const families = (await deps.selectFamilies(database, now))
    .filter((family) => allFamilies || allowlist.has(family.familyId))
    .slice(0, MAX_FAMILIES_PER_RUN);
  if (families.length === 0) return result;

  const byId = new Map(families.map((family) => [family.familyId, family]));
  await runIntroFollowups(database, deps, byId, result, now);
  await runActivityFollowups(database, deps, families, result, now);
  await runDaycareFollowups(database, deps, families, result, now);
  return result;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** The families a follow-up could reach: settled SMS households with a primary parent.
 * Consent, enrolment, volume and the clock are the GATE's business. */
async function selectFollowupFamilies(database: Database): Promise<FollowupFamily[]> {
  return database
    .select({
      familyId: schema.families.id,
      parentUserId: schema.users.id,
    })
    .from(schema.families)
    .innerJoin(
      schema.familyMembers,
      and(
        eq(schema.familyMembers.familyId, schema.families.id),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .where(
      and(
        eq(schema.families.onboardingStage, 'sms_active'),
        isNull(schema.families.scheduledDeletionAt),
      ),
    );
}

/**
 * The introductions that actually happened, inside the ask window.
 *
 * `status = 'both_accepted'` IS "the email went": the intro sweep sets that status only
 * after the send comes back `sent`, and stamps `closed_at` in the same call
 * (village/intros/run.ts `introduce`). So `closed_at` is the delivery instant, and there
 * is no separate timestamp to keep in step with it.
 */
async function readDueIntros(database: Database, now: Date): Promise<DueIntro[]> {
  const { floor, latest } = introFollowupWindow(now);
  const rows = await database
    .select({
      proposalId: schema.villageIntroProposals.id,
      familyAId: schema.villageIntroProposals.familyAId,
      familyBId: schema.villageIntroProposals.familyBId,
      introducedAt: schema.villageIntroProposals.closedAt,
    })
    .from(schema.villageIntroProposals)
    .where(
      and(
        eq(schema.villageIntroProposals.status, 'both_accepted'),
        // From the GRACE floor, not the window's own edge: the stage classifies the
        // just-expired rows itself so aging out is counted rather than silent.
        gte(schema.villageIntroProposals.closedAt, floor),
        lte(schema.villageIntroProposals.closedAt, latest),
      ),
    );
  // `closed_at` is nullable in the schema but never null on a `both_accepted` row — the
  // intro sweep stamps both in one call. The filter keeps the type honest rather than
  // asserting past it.
  return rows.flatMap((row) =>
    row.introducedAt === null ? [] : [{ ...row, introducedAt: row.introducedAt }],
  );
}

/**
 * The activities HALE placed, whose start time has passed inside the ask window.
 *
 * `source = 'placement'` is the provenance test, and it is the only one that means what
 * this feature needs. A placement is a row the calendar_add executor wrote from an
 * artifact the parent approved — Hale put it there, so Hale may ask how it went. The
 * other four sources are occasions the family told Hale ABOUT ('parent', 'channel',
 * 'email', 'party'); Hale did not set those up, and checking back on one is Hale asking
 * about a family's own life for no reason it can name.
 *
 * `deleted_at IS NULL` is the not-cancelled test: `calendar_cancel` soft-deletes the
 * placement rather than erasing it, so a live row is one that was never called off.
 */
async function readDuePlacements(
  database: Database,
  familyId: string,
  parentUserId: string,
  now: Date,
): Promise<DueActivity[]> {
  const { floor, latest } = activityFollowupWindow(now);
  const rows = await database
    .select({
      eventId: schema.familyEvents.id,
      familyId: schema.familyEvents.familyId,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      childId: schema.familyEvents.childId,
      sensitive: schema.familyEvents.sensitive,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        eq(schema.familyEvents.source, 'placement'),
        isNull(schema.familyEvents.deletedAt),
        gte(schema.familyEvents.startsAt, floor),
        lte(schema.familyEvents.startsAt, latest),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt));
  return rows.map((row) => ({
    ref: { table: 'family_events', id: row.eventId },
    familyId: row.familyId,
    // A PLACEMENT'S parent is the family's, and that is not a default slipping through:
    // Hale placed it from an artifact the household approved, so there is no mailbox it
    // came from. A BOOKING's parent is the booking's own — see readDueBookings.
    parentUserId,
    title: row.title,
    startsAt: row.startsAt,
    childId: row.childId,
    sensitive: row.sensitive,
  }));
}

/**
 * The two things Hale may ask how it went about — what it PLACED, and what a provider
 * CONFIRMED — as one list, oldest first.
 *
 * A booking whose YES placed a `source='parent'` row is invisible to the placement reader
 * (which filters `source='placement'`), and a booking matched to a placement is excluded
 * by `readDueBookings` so the placement reader owns it. One ask, not two, and not zero.
 */
async function readDueActivities(
  database: Database,
  familyId: string,
  parentUserId: string,
  now: Date,
): Promise<DueActivity[]> {
  const window = activityFollowupWindow(now);
  const [placements, bookings] = await Promise.all([
    readDuePlacements(database, familyId, parentUserId, now),
    readDueBookings(database, familyId, window),
  ]);
  const fromBookings: DueActivity[] = bookings.map((booking) => ({
    ref: { table: 'activity_bookings', id: booking.bookingId },
    familyId: booking.familyId,
    // THE ITEM'S OWN PARENT — whose mailbox the receipt arrived in (rule #5).
    parentUserId: booking.parentUserId,
    title: booking.title,
    startsAt: booking.firstSessionAt,
    // A booking binds no child, for the reason the offer path gives: `childRef` is
    // suggestive and never a binding, and a guess here would be a guess handed to the
    // teen age gate. A teen's confirmation writes no booking row at all, which is what
    // makes the null safe rather than permissive.
    childId: null,
    // `sensitive` is a column `family_events` carries and `activity_bookings` does not, so
    // a booking reaches `isPrivateEvent` as an ordinary class and that screen can only
    // ever pass it. Said plainly rather than implied: a health-flavoured receipt that
    // clears triage IS asked about. The bound is that it goes to the parent who already
    // received a text naming the same title, and the voice is handed that title and
    // nothing else - and closing it properly needs a sensitivity signal the extraction
    // contract does not carry today, not a default invented here.
    sensitive: false,
  }));
  // Oldest first across BOTH sources: with one slot a day, the item closest to falling
  // out of its window is the one worth spending it on.
  return [...placements, ...fromBookings].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

async function readFollowupChildren(
  database: Database,
  familyId: string,
): Promise<ReminderChild[]> {
  return database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
      gender: schema.children.gender,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
}

let followupAnthropic: Anthropic | undefined;

/**
 * The voice's client, resolved LAZILY — a function, not a value, for the reason the
 * router's screen client is: these deps are built on EVERY hourly tick, and the vast
 * majority of ticks have nothing due and never reach a model. A client constructed at
 * wiring time would turn a missing ANTHROPIC_API_KEY into a broken cron rather than the
 * honest `client_unavailable` deferral.
 */
function followupVoiceClient(): AgentClient {
  // Sweep composer under the nudge cron's maxDuration 300 (audit P1-7).
  followupAnthropic ??= budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS);
  return followupAnthropic;
}

export function defaultFollowupSweepDeps(): FollowupSweepDeps {
  return {
    selectFamilies: (database) => selectFollowupFamilies(database),
    loadDueIntros: readDueIntros,
    discoverableUserIds,
    loadDueActivities: (database, family, now) =>
      readDueActivities(database, family.familyId, family.parentUserId, now),
    loadDaycareSubjects,
    loadWeekdayCare,
    loadChildren: readFollowupChildren,
    loadInboundSince: inboundSince,
    buildGate: buildOutboundGatePorts,
    refuseUnbackedSend,
    dedupeActive: (database, dedupeKey) => dedupeActive(dedupeKey, database),
    resolveSendablePhone,
    recordSend: async (database, write) => {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({
          familyId: write.familyId,
          parentUserId: write.parentUserId,
          channel: 'sms',
          direction: 'out',
          category: 'followup',
          templateKey: write.templateKey,
          dedupeKey: write.dedupeKey,
          providerMessageId: write.providerMessageId,
          status: acceptedStatus('sms'),
          sentAt: write.sentAt,
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('followup asks: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row);
    },
    transport: createTwilioTransport(),
    voice: createFollowupVoice(followupVoiceClient),
    threadMessage: threadProactiveMessage,
  };
}
