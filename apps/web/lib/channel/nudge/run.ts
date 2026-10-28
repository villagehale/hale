import type { AgentClient } from '@hale/agent';
import { type Database, type RegistrationWindow, schema } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import { and, eq, lte } from 'drizzle-orm';
import type { WeekdayCareContext } from '~/lib/care/weekday';
import { loadWeekdayCareContext, weekdayCareEnabled } from '~/lib/care/weekday';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { dutyOverviewForWeeklyBubble } from '~/lib/channel/coparent/duty/asks';
import { absorbDutyLine } from '~/lib/channel/coparent/duty/copy';
import { f14Allowlist, f14Enabled } from '~/lib/channel/f14';
import {
  type FamilyTextRecipient,
  loadFamilyTextRecipients,
} from '~/lib/channel/family-recipients';
import { howItWentLinesForGroupWeekly } from '~/lib/channel/followup/run';
import { composeParentCallNameAsk } from '~/lib/channel/identity/call-name-voice';
import {
  type ParentCallNameAsk,
  type ParentCallNameState,
  decideParentCallName,
  deliverParentCallNameLine,
  loadParentCallName,
} from '~/lib/channel/identity/parent-call-name';
import { createFriendVoiceComposer } from '~/lib/channel/intake/friend-voice';
import {
  type LiveCandidates,
  readCandidates as readVillageCandidates,
} from '~/lib/channel/intake/radar';
import { readWindows as readRegistrationWindows } from '~/lib/channel/intake/radar';
import { type RadarChild, upcomingWeekend } from '~/lib/channel/intake/radar-decide';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import {
  type FamilyOutboundTarget,
  deliverFamilyOutbound,
  familyOutboundTarget,
  familySpeech,
  householdCopies,
  notePermanentSkip,
} from '~/lib/channel/linq/family-outbound';
import {
  absorbHowItWentLines,
  groupBothReaderFrench,
} from '~/lib/channel/linq/group-coparent-copy';
import { type OptOutForm, withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import {
  type ProactiveLedgerWrite,
  finalizeProactiveSend,
  recordProactiveSend,
  writeProactiveAudit,
} from '~/lib/channel/proactive/finalize';
import {
  type CadenceLane,
  errorLabel,
  handOffProactive,
  isQueuedForDecider,
  stackFrames,
} from '~/lib/channel/proactive/queue';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { weekdayFinderDedupeKey, weekdayFinderTemplateKey } from '~/lib/channel/weekday-care/key';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import type { HealthChild } from '~/lib/health/match';
import { localParts } from '~/lib/loop/prefs';
import { voiceClient } from '~/lib/loop/voice/compose';
import { type AbortedWindow, providerPreflight } from '~/lib/monitoring/provider-health';
import { addDaysToKey, weekWindow, zonedLocalInstant } from '~/lib/plan/spine';
import { matchRegistrationWindows } from '~/lib/registration/match-registration-windows';
import { loadClaimedWindowIds } from '~/lib/registration/sequence/claims';
import { type HouseholdFindBias, readHouseholdFindBias } from '~/lib/reviews/household-bias';
import { proactiveSearchSubject } from '~/lib/seasonal/moments';
import { recordActivityOffers } from '~/lib/village/live';
import { type WeatherPort, createOpenMeteoWeather } from '~/lib/weather/open-meteo';
import { type Nudge, type NudgeDecision, type NudgeSkipCounts, decideNudge } from './nudge-decide';
import { composeNudgeMessage } from './nudge-voice';
import { type SaturdayPlans, loadSaturdayPlans } from './saturday-plans';
import { proactiveNudgeTemplateKey } from './shell';

/**
 * VIL-239 · M4 — the 48-hour proactive nudge, swept hourly.
 *
 * The retention aha this exists for: two days after a stranger texts Hale their kids'
 * names, Hale texts THEM — once, unprompted, with something real. Not a re-engagement
 * ping, not a digest. One fact they can act on, or nothing.
 *
 * Scope. Two cohorts were specified, and they collapse to one predicate:
 *
 *   - the 48h-post-onboarding window (sms_active, provisioned 24-72h ago, not yet
 *     nudged), and
 *   - watch-mode families on the weekly rhythm (everyone older than that).
 *
 * Their union is exactly "sms_active AND provisioned at least 24h ago" — watch mode IS
 * the consent the gate already requires of both, and "not yet nudged" IS the gate's
 * 7-day cap for a family only three days old. So there is ONE query and one path, and
 * the {@link NudgeCohort} is derived afterwards for the audit trail rather than
 * duplicated into two sweeps that would drift.
 *
 * Everything unprompted goes through the F14 outbound gate (lib/channel/outbound-gate)
 * BEFORE any village read, weather call, or model spend — a family that pressed STOP
 * costs nothing to skip.
 *
 * Dark by default (D21): the sweep is a no-op unless {@link F14_ENABLED_ENV} is
 * exactly 'true' or the family is named in {@link F14_ALLOWLIST_ENV}.
 */

/** F14's dark-launch gate now lives in `~/lib/channel/f14` — it gates four surfaces,
 * not just this sweep, and a module that only wants the boolean should not have to
 * import a whole cron to get it. Re-exported so this module's callers are unchanged. */
export {
  F14_ALLOWLIST_ENV,
  F14_ENABLED_ENV,
  f14Allowlist,
  f14Enabled,
  f14EnabledFor,
} from '~/lib/channel/f14';

/**
 * The local hour a nudge may land in. Mid-morning: late enough that the house is
 * awake, early enough that a registration date is still actionable today. The cron
 * fires hourly, so this matches the whole HOUR — an exact-minute match would silently
 * drop every family whose cron tick landed a minute late.
 */
export const NUDGE_SEND_HOUR_LOCAL = 10;

/** A family is only a candidate for its first nudge once it has had a day to settle. */
const MIN_FAMILY_AGE_HOURS = 24;
/** Past this, the family is on the weekly rhythm rather than in its onboarding window. */
const ONBOARDING_COHORT_HOURS = 72;

/** Enough days to reach the coming Sunday from any weekday, plus slack. */
const WEATHER_DAYS = 8;

/** Filter first, then cap — a cap-then-filter would starve every family past the
 * oldest N of their slot forever. */
const MAX_NUDGE_FAMILIES_PER_RUN = 100;

/** Whether `now` sits in this family's local send hour. */
export function isNudgeSlot(now: Date, timeZone: string): boolean {
  return Math.floor(localParts(now, timeZone).minutes / 60) === NUDGE_SEND_HOUR_LOCAL;
}

export type NudgeCohort = 'onboarding_48h' | 'weekly_rhythm';

export interface NudgeFamily {
  familyId: string;
  parentUserId: string;
  /** The FSA, never the full postal code (rule #1). Null when the family has no area. */
  areaCoarse: string | null;
  timeZone: string;
  provisionedAt: Date;
  /** `families.primary_language`, handed to the live search so the model can weigh the
   * holidays this household is likely to keep. Optional so older fixtures stay valid. */
  language?: string | null;
}

export interface NudgeChildRow {
  id: string;
  name: string;
  dateOfBirth: string;
  /** As STORED. A date derived from an age a parent spoke earns the ±6-month early-edge
   * tolerance in the registration and health matchers; a birthday a parent typed does
   * not, and granting it anyway admits their child to windows they are not in yet. */
  dobPrecision: 'exact' | 'derived';
}

export interface GroupHowItWentLine {
  text: string;
  dedupeKey: string;
  parentUserId: string;
}

/** The ledger row a send writes, via the finalizer it shares with the hourly decider. */
export type NudgeLedgerWrite = ProactiveLedgerWrite;

export interface NudgeAuditRow {
  familyId: string;
  actor: string;
  actionTaken: string;
  targetTable: string;
  targetId: string;
  after: Record<string, unknown>;
}

export interface NudgeRunDeps {
  selectFamilies(database: Database, now: Date): Promise<NudgeFamily[]>;
  loadChildren(database: Database, familyId: string): Promise<NudgeChildRow[]>;
  /** Live web finds for the coming weekend (no stored catalog). `timeZone` lets the
   * search name seasonal moments (Halloween) that fall inside the window. */
  loadCandidates(
    database: Database,
    familyId: string,
    now?: Date,
    timeZone?: string,
    language?: string | null,
  ): Promise<LiveCandidates>;
  loadWindows(database: Database, areaCoarse: string, now?: Date): Promise<RegistrationWindow[]>;
  /** Registration windows an M7 sequence (VIL-242) is already preparing this family
   * for — the sequence announces those itself, on its own ladder. */
  loadClaimedWindowIds(database: Database, familyId: string): Promise<Set<string>>;
  weather: WeatherPort;
  /**
   * WHO THIS NUDGE IS FOR — every parent seat in the family with a live number, not the
   * one parent a family row happens to join to.
   *
   * REQUIRED, for the reason `transport` is (rule #11). A sweep that could be assembled
   * without it would decide one thing for the household, compose it once, and deliver
   * it to whoever answered the intake — which is what it did, while the weekly plan and
   * the event reminders beside it reached both parents (audit 2026-09-17).
   */
  loadRecipients(database: Database, familyId: string): Promise<FamilyTextRecipient[]>;
  /**
   * What this household has told Hale about its weekdays (VIL-360, lib/care/weekday).
   *
   * REQUIRED, for the reason the four around it are (rule #11): a sweep that could be
   * assembled without it would decide the weekday legs against an assumed empty
   * context and report `care_unstated` for a family that HAD answered — a skip counter
   * lying about the one thing the ask exists to learn. The feature being off is
   * expressed by the flag and carried into the decide as `'disarmed'`, never by
   * withholding this.
   */
  loadWeekdayCareContext(database: Database, familyId: string): Promise<WeekdayCareContext>;
  /**
   * Occupancy of the coming Saturday (VIL-365). REQUIRED (rule #11): withholding it
   * would look like an open Saturday. `'unread'` is only for a caller that is
   * explicitly not deciding this leg.
   */
  loadSaturdayPlans(
    database: Database,
    familyId: string,
    now: Date,
    timeZone: string,
  ): Promise<SaturdayPlans>;
  /**
   * This household's own activity verdicts (VIL-366). REQUIRED: an absent read
   * would rank the next find as if the parent had never answered.
   */
  loadHouseholdBias(database: Database, familyId: string): Promise<HouseholdFindBias>;
  /** A factory, not an instance: the gate's ports close over the db handle the sweep
   * is given, so a caller cannot accidentally gate one database against another. */
  buildGate(database: Database): OutboundGatePorts;
  dedupeActive(database: Database, dedupeKey: string): Promise<boolean>;
  /** The ONE send-side reader (sms-consent-core). It carries the verified +
   * non-revoked predicate itself, so a channel that may not be texted resolves to no
   * number whatever ran before it — the gate's enrolment check is a second answer to
   * the same question, never the thing that makes this one safe. */
  resolveSendablePhone(database: Database, parentUserId: string): Promise<string | null>;
  recordSend(database: Database, write: NudgeLedgerWrite): Promise<string>;
  recordActivityOffers: typeof recordActivityOffers;
  audit(database: Database, row: NudgeAuditRow): Promise<void>;
  /**
   * MEM-10 · close the open-loops promise this sweep exists to make good on. REQUIRED
   * for the same reason `transport` is (rule #11): a sweep assembled without it would
   * text a family and still report Hale as owing them the message it just sent — a debt
   * that is wrong in the direction that wastes a founder's attention every week.
   */
  fulfillCommitment: typeof fulfillCommitment;
  /**
   * The outbound SMS leg — REQUIRED, and that is the point (VIL-262). It was nullable
   * so a caller could decide + compose without sending, and the three P0s this sweep
   * shipped with were all the same shape: a message composed perfectly and dropped on
   * the floor because nothing was wired to send it. A sweep that cannot express "no
   * transport" cannot silently do that. A caller that genuinely wants no send belongs
   * behind an explicit, result-visible flag, never behind an absent dependency.
   */
  transport: ChannelTransport;
  /**
   * Where Hale-initiated copy for this family goes. Production reads
   * `families.linq_group_chat_id`. Absent means the legacy door, so a test
   * double with no family row keeps today's SMS path.
   */
  outboundTarget?(database: Database, familyId: string): Promise<FamilyOutboundTarget>;
  fetch?: typeof fetch;
  /**
   * Put the sent nudge in the parent's own text thread — REQUIRED, same reason as the
   * three above (rule #11). `channel_messages` carries no body, so a sweep that could be
   * assembled without this would text a parent something and leave their reply with no
   * antecedent the coach can read; that is the state two prod health nudges were in on
   * 2026-08-22. There is no "no thread" to express: the anchor is derived from the
   * family and parent ids (lib/channel/thread.ts).
   */
  threadMessage: typeof threadProactiveMessage;
  /**
   * Whether this parent still needs a call-name, and whether Hale already asked.
   *
   * REQUIRED (rule #11). A sweep that could be assembled without it would either
   * ask inside the find itself — spending the nudge cap and burying the line — or
   * never ask a family whose first radar was empty. The absence of a name is a
   * state this returns, not a missing dependency.
   */
  loadParentCallName(
    database: Database,
    input: { familyId: string; parentUserId: string },
  ): Promise<ParentCallNameState>;
  /**
   * The name ask after a find, written by the onboarding model for the decided
   * kind (VIL-417). Null means it could not be written: nothing is sent and the
   * composer has already paged #ops.
   */
  composeNameAsk(input: { ask: ParentCallNameAsk; language: 'en' | 'fr' }): Promise<string | null>;
  /**
   * How-it-went lines the weekly group bubble absorbs. Absent means none.
   * Those lines are not also sent as their own bubble.
   */
  pendingHowItWent?(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<readonly GroupHowItWentLine[]>;
  /**
   * Sunday duty overview folded into this same bubble. Absent means none.
   * Flag off returns null before any read. A placeholder is not appended.
   */
  pendingDutyOverview?(
    database: Database,
    input: {
      familyId: string;
      parentUserId: string;
      now: Date;
      replyClient?: AgentClient | null;
    },
  ): Promise<{ text: string; commit: () => Promise<void> } | null>;
  client: AgentClient | null;
}

export interface NudgeRunResult {
  /** False when neither the flag nor the allowlist armed the sweep (D21). */
  enabled: boolean;
  /** Families that reached the gate — armed, and inside their local send slot. */
  evaluated: number;
  sent: number;
  /** Evaluated and had nothing worth a text. The metric that says whether the nudge
   * is a signal or a habit. */
  quiet: number;
  deduped: number;
  /**
   * VIL-226 · copies handed to the family's proactive queue instead of sent, because
   * PROACTIVE_CADENCE is live. The hourly decider sends them or holds them by name.
   */
  queued: number;
  /**
   * VIL-226 · copies whose candidate row could not be stored while PROACTIVE_CADENCE is
   * shadow. The sweep went on with them as it would have unset; the decider's shadow record
   * is what misses them.
   */
  shadowUnqueued: number;
  failed: number;
  held: Record<ProactiveHoldReason, number>;
  /**
   * WHY the quiet families were quiet, summed across the run — the detail behind
   * {@link NudgeRunResult.quiet}, which is a count of families and says nothing about
   * what stopped each one (rule #11).
   *
   * Only the weekday legs report reasons; the three older legs return null and are
   * not retrofitted here. A reason ABSENT from this map is not the same as a reason at
   * zero: absent means the leg never ran (the feature is disarmed), zero would mean it
   * ran and did not hit that case.
   */
  skips: NudgeSkipCounts;
  /** Present when the provider pre-flight cancelled the window (VIL-255). */
  aborted?: AbortedWindow;
}

function emptyResult(enabled: boolean): NudgeRunResult {
  return {
    enabled,
    evaluated: 0,
    sent: 0,
    quiet: 0,
    deduped: 0,
    queued: 0,
    shadowUnqueued: 0,
    failed: 0,
    held: { not_enrolled: 0, opt_out_unread: 0, no_watch_consent: 0, quiet_hours: 0 },
    skips: {},
  };
}

function cohortOf(family: NudgeFamily, now: Date): NudgeCohort {
  const ageHours = (now.getTime() - family.provisionedAt.getTime()) / 3_600_000;
  return ageHours <= ONBOARDING_COHORT_HOURS ? 'onboarding_48h' : 'weekly_rhythm';
}

/**
 * A nudge's natural identity, so the hourly cron can fire twice in a slot (or twice in
 * a week) and send once PER RECIPIENT. A registration nudge is one per family per
 * WINDOW — the same date is never announced twice to the same parent, ever. A weather
 * swap is one per family per WEEK, keyed on the family-local Monday.
 *
 * THE RECIPIENT IS IN THE KEY because `channel_messages.dedupe_key` is UNIQUE where
 * present: a household's two parents sharing one key is one send followed by a
 * duplicate-key crash, not one duplicate text.
 *
 * It is APPENDED WITH A `#`, and only for the health kind does the separator matter: a
 * health nudge's key IS its cross-surface told-marker, whose ref is parsed back out by
 * colon-splitting into exactly three parts (health/checkpoints.ts parseCheckpointRef).
 * A recipient appended with a colon would make the marker unparseable and the family
 * would be told the same checkpoint forever; `#` is outside the ref grammar, and
 * `loadToldCheckpointRefs` strips it before parsing.
 *
 * AN EXHAUSTIVE SWITCH, NOT A CHAIN OF `if`s AND A BARE RETURN. The tail used to be
 * the weather swap's key and it dereferenced nothing off `nudge`, so a new kind
 * COMPILED and silently took the weather swap's weekly key — the find would have been
 * deduped against a swap and vanished with no error anywhere. `assertNever` makes that
 * unexpressible: a fifth kind is a type error here before it is a missing text.
 */
export function dedupeKeyFor(
  nudge: Nudge,
  familyId: string,
  parentUserId: string,
  now: Date,
  timeZone: string,
): string {
  switch (nudge.kind) {
    case 'registration':
      return `nudge:${familyId}:registration:${nudge.windowRef.id}:${parentUserId}`;
    case 'weather_swap':
      return `nudge:${familyId}:weather_swap:${weekWindow(now, timeZone).startKey}:${parentUserId}`;
    case 'weekday_dropin':
      // Per WEEK like the swap, not per candidate: the sessions recur, and a key per
      // row would text a family a different library every day of the week.
      return `nudge:${familyId}:weekday_dropin:${weekWindow(now, timeZone).startKey}:${parentUserId}`;
    case 'weekday_care':
      // Per prompt kind, with no week in it. The parser's own module mints the key
      // because the answer path reads the scope back out of this string.
      return weekdayFinderDedupeKey(familyId, nudge.ask, parentUserId);
    case 'empty_saturday':
      // Once per Saturday per parent. The candidate is not in the key: the ask is
      // about the day, and a second civic row the same morning must not re-text.
      return `nudge:${familyId}:empty_saturday:${nudge.saturday}:${parentUserId}`;
    default:
      return assertNever(nudge);
  }
}

/**
 * When a queued nudge stops being worth a text: the end of the local day it is about,
 * so the decider can drop it then. The weekday-care ask is about no day.
 */
export function nudgeWorthlessAfter(nudge: Nudge, now: Date, timeZone: string): Date | null {
  const day = nudgeDay(nudge, now, timeZone);
  return day === null ? null : zonedLocalInstant(addDaysToKey(day, 1), '00:00', timeZone);
}

function nudgeDay(nudge: Nudge, now: Date, timeZone: string): string | null {
  switch (nudge.kind) {
    case 'weekday_dropin':
      return nudge.eventDate;
    case 'empty_saturday':
      return nudge.saturday;
    case 'weather_swap': {
      // The decide chose this day from the same weekend, so it is always there.
      const slot = upcomingWeekend(now, timeZone).find((weekend) => weekend.day === nudge.day);
      if (!slot) throw new Error(`nudgeWorthlessAfter: no ${nudge.day} in the coming weekend`);
      return slot.date;
    }
    case 'registration':
    case 'weekday_care':
      return null;
    default:
      return assertNever(nudge);
  }
}

/** A registration nudge is timed to a municipal clock, so it never waits for the decider. */
export function nudgeLane(kind: Nudge['kind']): CadenceLane {
  return kind === 'registration' ? 'immediate' : 'candidate';
}

/** The compiler's own proof that a union was handled. Throws only if a caller reached
 * it through an `as` or an untyped boundary — it exists for the build error, not the
 * runtime one. */
function assertNever(value: never): never {
  throw new Error(`nudge: unhandled kind ${JSON.stringify(value)}`);
}

/** A find the parent can act on. Not a care question, not a health checkpoint,
 * and not the empty-Saturday ask — that one must not grow the call-name second text. */
function isFindNudge(kind: Nudge['kind']): boolean {
  return kind === 'registration' || kind === 'weather_swap' || kind === 'weekday_dropin';
}

/** Rec-morning, the weekly follow-up, and find results are for both parents. */
function isBothParentsNudge(kind: Nudge['kind']): boolean {
  return kind !== 'empty_saturday';
}

/**
 * The children a proactive message may be built around: the family's UNDER-13s.
 *
 * Rule #1's deterministic floor, applied at the source rather than as a redaction on
 * the way out — a 13+ child is never named, never drives an age match, and never has
 * an activity attributed to them over SMS. `deriveStage` is computed LIVE from the
 * date of birth, never stored, so the gate cannot go stale on a birthday.
 *
 * `healthChildren` (VIL-243 · M8) is the ONE list that includes 13+ children, and it is
 * built here so the exception is visible next to the rule it bends. A school records
 * check is the PARENT'S legal obligation for a teenager exactly as it is for a
 * seven-year-old, so silence would be the privacy-preserving choice that costs a family
 * a school-attendance problem. What changes for a teen is the WORDING, never the
 * existence of the message — and the name is stripped HERE, at the source, so a teen's
 * name cannot reach a template even if a downstream check were removed.
 */
function splitByStage(rows: readonly NudgeChildRow[], now: Date) {
  const children: RadarChild[] = [];
  const teenChildIds: string[] = [];
  const healthChildren: HealthChild[] = [];
  for (const row of rows) {
    // `now`, not the wall clock: a HealthChild carries a stage AND an age, and reading
    // them at two different instants would let a child on their thirteenth birthday be
    // teen-gated at one age and band-matched at another.
    const isTeen = deriveStage(row.dateOfBirth, now) === 'teenager';
    healthChildren.push({
      id: row.id,
      name: isTeen ? null : row.name,
      ageMonths: ageInMonths(row.dateOfBirth, now),
      dobPrecision: row.dobPrecision,
      isTeen,
    });
    if (isTeen) {
      teenChildIds.push(row.id);
      continue;
    }
    children.push({
      id: row.id,
      name: row.name,
      ageMonths: ageInMonths(row.dateOfBirth, now),
      dobPrecision: row.dobPrecision,
    });
  }
  return { children, teenChildIds, healthChildren };
}

async function decideForFamily(
  database: Database,
  family: NudgeFamily,
  deps: NudgeRunDeps,
  now: Date,
): Promise<
  NudgeDecision & {
    offeredPick?: ActivityPick;
    search?: { searchReason: string | null; dropped: Record<string, number> };
  }
> {
  const childRows = await deps.loadChildren(database, family.familyId);
  const { children, teenChildIds, healthChildren } = splitByStage(childRows, now);
  // A family with no children on file has nothing any nudge class could rest on.
  if (healthChildren.length === 0) return { nudge: null, skips: {} };

  const area = family.areaCoarse;
  // Weekend suggestions need an under-13. The weekday finder does not: a teen-only
  // household still gets the household after-school ask when a weekend send exists.
  // Skipping the village, registration, and weather reads here only skips those legs.
  const weekendPossible = children.length > 0;
  // THE FLAG SHORT-CIRCUITS BEFORE THE READ, so a disarmed feature costs nothing and
  // reports nothing (see WeekdayCareInput: silent counters mean the flag, zeroed ones
  // would mean the legs ran).
  const weekdayArmed = weekdayCareEnabled();
  const [
    candidates,
    windowRows,
    weather,
    claimedWindowIds,
    weekdayCare,
    saturdayPlans,
    householdBias,
  ] = await Promise.all([
    weekendPossible
      ? deps.loadCandidates(database, family.familyId, now, family.timeZone, family.language)
      : Promise.resolve([] as LiveCandidates),
    area && weekendPossible ? deps.loadWindows(database, area, now) : Promise.resolve([]),
    // Weather is an input, never a blocker: the port swallows its own failures.
    area && weekendPossible
      ? deps.weather.getDailyOutlook(area, WEATHER_DAYS).catch(() => [])
      : Promise.resolve([]),
    deps.loadClaimedWindowIds(database, family.familyId),
    weekdayArmed
      ? deps.loadWeekdayCareContext(database, family.familyId)
      : Promise.resolve('disarmed' as const),
    deps.loadSaturdayPlans(database, family.familyId, now, family.timeZone),
    deps.loadHouseholdBias(database, family.familyId),
  ]);

  const windows = area
    ? matchRegistrationWindows({
        windows: windowRows,
        postal: area,
        childrenAgesMonths: children
          .map((child) => child.ageMonths)
          .filter((age): age is number => age !== null),
        now,
      })
    : [];

  const decision = decideNudge({
    children,
    candidates,
    windows,
    weather,
    teenChildIds,
    healthChildren,
    areaCoarse: area,
    claimedWindowIds,
    weekdayCare,
    saturdayPlans,
    householdBias,
    now,
    timeZone: family.timeZone,
  });
  const search = {
    searchReason: candidates.searchReason ?? null,
    dropped: candidates.dropped ?? {},
  };
  if (decision.nudge?.kind !== 'weather_swap' && decision.nudge?.kind !== 'weekday_dropin')
    return { ...decision, search };
  const selectedId = decision.nudge.candidateRef.id;
  const selected = candidates.find((candidate) => candidate.id === selectedId);
  return {
    ...decision,
    search,
    offeredPick: selected?.sourceUrl
      ? {
          name: selected.title,
          ageFit: selected.ageRange ?? '',
          when: selected.whenLabel,
          price: selected.priceLevel === 'free' ? 'free' : null,
          sourceName: selected.venueName ?? '',
          source: 'web',
          sourceUrl: selected.sourceUrl,
          eventDate: selected.eventDate ?? undefined,
          placeId: selected.placeId ?? undefined,
          civicVenueId: selected.civicVenueId ?? undefined,
        }
      : undefined,
  };
}

/**
 * What one family's tick DID, counted per recipient rather than per family.
 *
 * A household is two numbers now (channel/family-recipients.ts), and a nudge can
 * honestly reach one parent and be held for the other — the co-parent past 21:00 in
 * their own timezone, the parent who pressed STOP. One enum per family could only
 * report the first of those. `quiet` (nothing worth saying) stays a property of the
 * family, because the decision is the household's.
 */
type FamilyTally = {
  quiet: boolean;
  sent: number;
  deduped: number;
  queued: number;
  shadowUnqueued: number;
  held: ProactiveHoldReason[];
  /** The decide's own reasons for this family. A property of the DECISION, so it is
   * the household's like `quiet` is, not the recipient's. */
  skips: NudgeSkipCounts;
};

function emptyTally(overrides: Partial<FamilyTally> = {}): FamilyTally {
  return {
    quiet: false,
    sent: 0,
    deduped: 0,
    queued: 0,
    shadowUnqueued: 0,
    held: [],
    skips: {},
    ...overrides,
  };
}

async function runForFamily(
  database: Database,
  family: NudgeFamily,
  deps: NudgeRunDeps,
  now: Date,
): Promise<FamilyTally> {
  // BOTH NUMBERS. `selectFamilies` keys on the primary parent because that is what a
  // family row joins to; who Hale actually texts is every parent seat with a live
  // number, and the site promises the co-parent exactly this.
  const recipients = await deps.loadRecipients(database, family.familyId);
  if (recipients.length === 0) return emptyTally({ held: ['not_enrolled'] });

  // EVERY RECIPIENT IS GATED BEFORE ANYBODY IS SENT TO. The gate is enrolment, watch
  // consent, and quiet hours. A count does not hold anyone. Same-item dedupe, keyed
  // per recipient, is what stops a second copy of this nudge.
  //
  // On a tick where one parent is allowed and the other is inside their own quiet
  // hours, the first is sent and the second is held `quiet_hours`. The next tick,
  // outside those hours, can still send the second: nothing was spent that would
  // refuse them.
  const allowed: Array<{ recipient: FamilyTextRecipient; optOut: OptOutForm }> = [];
  const held: ProactiveHoldReason[] = [];
  for (const recipient of recipients) {
    const verdict = await assertProactiveSendAllowed(
      { familyId: family.familyId, parentUserId: recipient.parentUserId, kind: 'nudge', now },
      deps.buildGate(database),
    );
    if (verdict.allowed) allowed.push({ recipient, optOut: verdict.optOut });
    else held.push(verdict.reason);
  }
  if (allowed.length === 0) return emptyTally({ held });

  const cohort = cohortOf(family, now);
  const decision = await decideForFamily(database, family, deps, now);
  if (decision.nudge === null) {
    // Silence is the outcome, and it is recorded: an absent row is indistinguishable
    // from a family the sweep never looked at, and the difference is the whole metric.
    // The headline literal STAYS — it is still true — and the per-leg reasons ride
    // beside it, which is what makes a PIPEDA-exportable row answer "why was this
    // family quiet" rather than only "this family was quiet".
    await deps.audit(database, {
      familyId: family.familyId,
      actor: 'system',
      actionTaken: 'proactive_nudge_skipped',
      targetTable: 'families',
      targetId: family.familyId,
      after: {
        reason: 'nothing_worth_saying',
        cohort,
        skips: decision.skips,
        // Why the live search came back short, and why picks were dropped.
        search: decision.search ?? null,
      },
    });
    return emptyTally({ quiet: true, skips: decision.skips });
  }
  const nudge = decision.nudge;

  // Per recipient, and checked BEFORE the model call: a re-fired cron must cost nothing.
  const pending: Array<{ recipient: FamilyTextRecipient; optOut: OptOutForm; dedupeKey: string }> =
    [];
  let deduped = 0;
  for (const { recipient, optOut } of allowed) {
    const dedupeKey = dedupeKeyFor(
      nudge,
      family.familyId,
      recipient.parentUserId,
      now,
      family.timeZone,
    );
    if (
      (await deps.dedupeActive(database, dedupeKey)) ||
      (await isQueuedForDecider(database, family.familyId, dedupeKey))
    ) {
      deduped += 1;
    } else {
      pending.push({ recipient, optOut, dedupeKey });
    }
  }
  if (pending.length === 0) return emptyTally({ deduped, held });

  // ONE COMPOSE FOR THE HOUSEHOLD. The nudge is a fact about this family's week, not
  // about a parent, so composing it twice would spend the model twice to say the same
  // thing — and risk saying it two different ways to two people in one house.
  const message = await composeNudgeMessage(nudge, {
    familyId: family.familyId,
    database,
    client: deps.client,
  });
  if (message === null) {
    await deps.audit(database, {
      familyId: family.familyId,
      actor: 'system',
      actionTaken: 'proactive_nudge_skipped',
      targetTable: 'families',
      targetId: family.familyId,
      after: {
        reason: nudge.kind === 'empty_saturday' ? 'saturday_unvoiced' : 'unvoiced',
        kind: nudge.kind,
      },
    });
    return emptyTally({ quiet: true });
  }

  // VIL-226 · the family queue. Unset sends as before and writes nothing; shadow queues
  // and still sends; live queues and the hourly decider sends.
  const templateKey =
    nudge.kind === 'weekday_care'
      ? weekdayFinderTemplateKey(nudge.ask)
      : proactiveNudgeTemplateKey(nudge.kind);
  const handedOff = await handOffProactive(
    database,
    pending.map(({ recipient, dedupeKey }) => ({
      familyId: family.familyId,
      parentUserId: recipient.parentUserId,
      kind: 'nudge' as const,
      category: 'nudge' as const,
      templateKey,
      what: message,
      why: nudge.kind,
      sourceUrl: nudge.kind === 'empty_saturday' ? nudge.url : null,
      worthlessAfter: nudgeWorthlessAfter(nudge, now, family.timeZone),
      parentRequested: false,
      dedupeKey,
    })),
    nudgeLane(nudge.kind),
  );
  if (handedOff === 'queued') {
    await deps.audit(database, {
      familyId: family.familyId,
      actor: 'system',
      actionTaken: 'proactive_nudge_queued',
      targetTable: 'families',
      targetId: family.familyId,
      after: { kind: nudge.kind, cohort, copies: pending.length },
    });
    return emptyTally({ deduped, held, queued: pending.length });
  }
  const shadowUnqueued = handedOff === 'send_shadow_unqueued' ? pending.length : 0;

  let sent = 0;
  /** The row a family-scoped ledger write points at — the first copy that actually
   * left, in the reader's stable primary-parent-first order. */
  let firstMessageId: string | null = null;

  const target = deps.outboundTarget
    ? await deps.outboundTarget(database, family.familyId)
    : await familyOutboundTarget(database, family.familyId);
  // One bubble in the group. Both parents still get their own copy when the
  // family has no group. The weekly cap is counted on the ledger, so the
  // second seat is held on the next tick rather than texted again.
  const copies = householdCopies(target, pending);
  let wireMessage = message;
  let absorbed: readonly GroupHowItWentLine[] = [];
  let dutyFold: { text: string; commit: () => Promise<void> } | null = null;
  if (target.channel === 'group') {
    const speakerId = copies[0]?.recipient.parentUserId ?? '';
    const speech = await familySpeech(database, family.familyId, speakerId);
    if (speech.language === 'fr' && isBothParentsNudge(nudge.kind)) {
      wireMessage = groupBothReaderFrench(message);
    }
    if (nudge.kind !== 'registration' && deps.pendingHowItWent) {
      absorbed = await deps.pendingHowItWent(database, {
        familyId: family.familyId,
        parentUserId: speakerId,
        now,
      });
      wireMessage = absorbHowItWentLines(
        wireMessage,
        absorbed.map((line) => line.text),
      );
    }
    if (nudge.kind !== 'registration' && deps.pendingDutyOverview) {
      dutyFold = await deps.pendingDutyOverview(database, {
        familyId: family.familyId,
        parentUserId: speakerId,
        now,
        replyClient: deps.client,
      });
      if (dutyFold) {
        const next = absorbDutyLine(wireMessage, dutyFold.text);
        if (next === wireMessage) dutyFold = null;
        else wireMessage = next;
      }
    }
  }

  for (const { recipient, optOut, dedupeKey } of copies) {
    const to = await deps.resolveSendablePhone(database, recipient.parentUserId);
    if (!to) {
      // The gate just said this parent has a live channel, so there IS one — a missing
      // number here is a contradiction, not a state to paper over.
      throw new Error(`runNudgeCron: no send target for parent ${recipient.parentUserId}`);
    }

    const delivered = await deliverFamilyOutbound(database, {
      familyId: family.familyId,
      body: withOptOut(wireMessage, optOut),
      to,
      legacy: deps.transport,
      target,
      fetch: deps.fetch,
      now,
      bubbleKind: nudge.kind === 'registration' ? 'rec_morning' : 'weekly_followup',
    });
    if (delivered.status === 'held') {
      await deps.audit(database, {
        familyId: family.familyId,
        actor: 'system',
        actionTaken: 'proactive_nudge_skipped',
        targetTable: 'families',
        targetId: family.familyId,
        after: { reason: delivered.reason, cohort },
      });
      return emptyTally({ held, shadowUnqueued });
    }
    if (delivered.status === 'skipped') {
      console.warn(
        { familyId: family.familyId, code: delivered.reason },
        'nudge: outbound skipped',
      );
      if (delivered.reason !== 'not_configured') {
        await notePermanentSkip(database, {
          familyId: family.familyId,
          parentUserId: recipient.parentUserId,
          category: 'nudge',
          templateKey:
            nudge.kind === 'weekday_care'
              ? weekdayFinderTemplateKey(nudge.ask)
              : proactiveNudgeTemplateKey(nudge.kind),
          dedupeKey,
          reason: delivered.reason,
          now,
        });
      }
      continue;
    }
    const { providerMessageId } = delivered;

    // THE LEDGER ROW, THE TRAIL AND THE THREAD (proactive/finalize.ts), shared with the
    // hourly decider so a send from either path leaves the same rows. The thread is
    // where THIS parent's answer will be read — their own, one per recipient — and it
    // gets the COMPOSED sentence, never the wire body: the CASL line belongs on the wire
    // and nowhere else.
    const messageId = await finalizeProactiveSend(database, deps, {
      familyId: family.familyId,
      recipientUserId: recipient.parentUserId,
      channel: delivered.channel === 'imessage' ? 'imessage' : 'sms',
      providerMessageId,
      providerChatId: delivered.chatId,
      sentAt: now,
      items: [
        {
          parentUserId: recipient.parentUserId,
          category: 'nudge',
          templateKey:
            nudge.kind === 'weekday_care'
              ? weekdayFinderTemplateKey(nudge.ask)
              : proactiveNudgeTemplateKey(nudge.kind),
          dedupeKey,
        },
      ],
      composed: message,
      audit: {
        actionTaken: 'proactive_nudge_sent',
        // Enum-shaped provenance only — never the rendered body (rule #1). A health nudge
        // also names its checkpoint (a reviewed table constant, never PII), so the trail
        // says WHICH errand was raised without a join back to the ledger row's dedupe key.
        after: {
          kind: nudge.kind,
          cohort,
          // Which SEAT this copy went to. The row already names the parent; this names
          // the relationship, which is what a founder reading the trail is asking.
          role: recipient.role,
        },
      },
    });
    if (dutyFold) {
      try {
        await dutyFold.commit();
      } catch (err) {
        console.warn(
          { err: err instanceof Error ? err.name : 'unknown', familyId: family.familyId },
          'nudge: weekly absorbed a duty line but did not record it',
        );
      }
      dutyFold = null;
    }
    if (absorbed.length > 0 && typeof database.insert === 'function') {
      for (const line of absorbed) {
        try {
          await database.insert(schema.channelMessages).values({
            familyId: family.familyId,
            parentUserId: line.parentUserId,
            channel: delivered.channel === 'imessage' ? 'imessage' : 'sms',
            direction: 'out',
            category: 'reply',
            templateKey: 'followup:activity',
            dedupeKey: line.dedupeKey,
            providerChatId: delivered.chatId,
            status: acceptedStatus(delivered.channel === 'imessage' ? 'imessage' : 'sms'),
            sentAt: now,
          });
        } catch (err) {
          console.warn(
            { err: err instanceof Error ? err.name : 'unknown', familyId: family.familyId },
            'nudge: weekly absorbed a how-it-went line but did not claim it',
          );
        }
      }
      absorbed = [];
    }
    if (firstMessageId === null) firstMessageId = messageId;
    sent += 1;

    // A FIND is the value moment the name question waits for, when the opening
    // radar had nothing to show. Weekday-care and health checkpoints are questions
    // of their own and do not earn this ask. A claimed group already asked the
    // name on the ladder, and a second bubble in this turn is not allowed.
    // Families without a group still get the 1:1 ask. A failure here does not
    // unsend the find.
    if (isFindNudge(nudge.kind) && target.channel !== 'group') {
      try {
        const callName = await deps.loadParentCallName(database, {
          familyId: family.familyId,
          parentUserId: recipient.parentUserId,
        });
        const nameLine = decideParentCallName({ ...callName, isWin: true });
        if (nameLine.kind !== 'none') {
          const body = await deps.composeNameAsk({ ask: nameLine, language: 'en' });
          if (body === null) {
            console.warn(
              { familyId: family.familyId, kind: nameLine.kind },
              'nudge: name ask not written; nothing sent after the find',
            );
          } else {
            await deliverParentCallNameLine(
              database,
              {
                familyId: family.familyId,
                parentUserId: recipient.parentUserId,
                to,
                now,
                body,
                templateKey: nameLine.templateKey,
              },
              { transport: deps.transport, threadMessage: deps.threadMessage },
            );
          }
        }
      } catch (err) {
        console.error(
          { err, familyId: family.familyId },
          'nudge: parent name ask failed (find already sent)',
        );
      }
    }
  }

  // ONCE PER HOUSEHOLD, not once per number: both ledgers below record a fact about the
  // FAMILY, and a second write would be Hale asserting twice what happened once.
  if (firstMessageId !== null) {
    if (decision.offeredPick)
      await deps.recordActivityOffers(database, family.familyId, [decision.offeredPick], now);
    await recordFamilyLedgers(database, { family, nudge, messageId: firstMessageId, now }, deps);
  }
  return { quiet: false, sent, deduped, queued: 0, shadowUnqueued, held, skips: decision.skips };
}

/**
 * The two family-scoped ledger writes a nudge causes, kept together because they share
 * one rule: each is written ONCE per nudge, after the send, against the message that
 * carried it — never once per recipient.
 */
async function recordFamilyLedgers(
  database: Database,
  args: { family: NudgeFamily; nudge: Nudge; messageId: string; now: Date },
  deps: NudgeRunDeps,
): Promise<void> {
  const { family, messageId, now } = args;
  // MEM-10 · this sweep is what makes the intake radar's forward beat true, so a send —
  // ANY send — is what pays that promise off. Not narrowed to the weekend class on
  // purpose: what the beat promised a geo-empty family is that Hale would come back with
  // something real, and a registration date they can act on is more of that, not less.
  // Closed AFTER the send, against the row that carried it; a family owed nothing gets
  // the ledger's `none_open`, which is the common outcome and not a failure.
  await deps.fulfillCommitment(database, {
    familyId: family.familyId,
    kind: 'first_find',
    channelMessageId: messageId,
    now,
  });
}

export async function runNudgeCron(
  database: Database,
  deps: NudgeRunDeps = defaultNudgeRunDeps(),
  now: Date = new Date(),
): Promise<NudgeRunResult> {
  const allFamilies = f14Enabled();
  const allowlist = f14Allowlist();
  if (!allFamilies && allowlist.size === 0) return emptyResult(false);

  const result = emptyResult(true);
  const families = (await deps.selectFamilies(database, now))
    .filter((family) => allFamilies || allowlist.has(family.familyId))
    .filter((family) => isNudgeSlot(now, family.timeZone))
    .slice(0, MAX_NUDGE_FAMILIES_PER_RUN);
  if (families.length === 0) return result;

  // VIL-255: one provider pre-flight before the fan-out. Most hours select nobody, so
  // this sits after the slot filter and costs nothing then.
  const preflight = await providerPreflight(database, 'nudge_sweep', deps.client, now);
  if (!preflight.proceed) {
    return { ...result, aborted: { ...preflight.abort, skipped: families.length } };
  }

  for (const family of families) {
    result.evaluated += 1;
    try {
      const outcome = await runForFamily(database, family, deps, now);
      // The DECISION is per family and the SENDING is per recipient, so the two are
      // added differently and deliberately.
      if (outcome.quiet) result.quiet += 1;
      result.sent += outcome.sent;
      result.deduped += outcome.deduped;
      result.queued += outcome.queued;
      result.shadowUnqueued += outcome.shadowUnqueued;
      for (const reason of outcome.held) result.held[reason] += 1;
      for (const [reason, count] of Object.entries(outcome.skips)) {
        const key = reason as keyof NudgeSkipCounts;
        result.skips[key] = (result.skips[key] ?? 0) + count;
      }
    } catch (err) {
      // One family's bad data must not silence every family after it. Never the error
      // itself: a refused candidate insert reports the row, composed text and all. Its
      // class and where it was thrown still find a bug.
      result.failed += 1;
      console.error(
        { err: errorLabel(err), at: stackFrames(err), familyId: family.familyId },
        'nudge: family sweep failed',
      );
    }
  }
  return result;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * The families a proactive nudge could reach: settled SMS families with a primary
 * parent. Consent, enrolment, volume and the clock are the GATE's business — selecting
 * on them here would put the same policy in two places and let them disagree.
 */
async function selectNudgeFamilies(database: Database, now: Date): Promise<NudgeFamily[]> {
  const rows = await database
    .select({
      familyId: schema.families.id,
      areaCoarse: schema.families.areaCoarse,
      language: schema.families.primaryLanguage,
      provisionedAt: schema.families.createdAt,
      parentUserId: schema.users.id,
      timeZone: schema.users.timezone,
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
        lte(schema.families.createdAt, new Date(now.getTime() - MIN_FAMILY_AGE_HOURS * 3_600_000)),
      ),
    );
  return rows;
}

async function readNudgeChildren(database: Database, familyId: string): Promise<NudgeChildRow[]> {
  const rows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
      dobPrecision: schema.children.dobPrecision,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  // The column is free-form text with an 'exact' default, so only the literal 'derived'
  // buys the tolerance — an unrecognised value must not silently earn six months of it.
  return rows.map((row) => ({
    ...row,
    dobPrecision: row.dobPrecision === 'derived' ? ('derived' as const) : ('exact' as const),
  }));
}

export function defaultNudgeRunDeps(): NudgeRunDeps {
  return {
    selectFamilies: selectNudgeFamilies,
    loadChildren: readNudgeChildren,
    recordActivityOffers,
    loadCandidates: (database, familyId, now, timeZone, language) =>
      readVillageCandidates(database, familyId, {
        window: 'this coming weekend',
        subject: proactiveSearchSubject(now ?? new Date(), timeZone ?? DEFAULT_TIMEZONE, language),
        now,
      }),
    loadWindows: (database, areaCoarse) => readRegistrationWindows(database, areaCoarse),
    loadClaimedWindowIds: (database, familyId) => loadClaimedWindowIds(database, familyId),
    loadRecipients: (database, familyId) => loadFamilyTextRecipients(database, familyId),
    loadWeekdayCareContext,
    loadSaturdayPlans,
    loadHouseholdBias: readHouseholdFindBias,
    weather: createOpenMeteoWeather(),
    buildGate: buildOutboundGatePorts,
    dedupeActive: (database, dedupeKey) => dedupeActive(dedupeKey, database),
    resolveSendablePhone,
    recordSend: recordProactiveSend,
    audit: writeProactiveAudit,
    transport: createOutboundTransport(),
    outboundTarget: familyOutboundTarget,
    client: voiceClient(),
    fulfillCommitment,
    threadMessage: threadProactiveMessage,
    loadParentCallName,
    composeNameAsk: (input) =>
      composeParentCallNameAsk(createFriendVoiceComposer(voiceClient()), input),
    pendingHowItWent: howItWentLinesForGroupWeekly,
    pendingDutyOverview: dutyOverviewForWeeklyBubble,
  };
}
