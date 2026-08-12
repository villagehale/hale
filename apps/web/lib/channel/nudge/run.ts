import type { AgentClient } from '@hale/agent';
import { type Database, type RegistrationWindow, schema } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import { and, eq, lte } from 'drizzle-orm';
import type { RadarCandidate, RadarChild } from '~/lib/channel/intake/radar-decide';
import {
  readCandidates as readVillageCandidates,
  readWindows as readRegistrationWindows,
} from '~/lib/channel/intake/radar';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { dedupeActive } from '~/lib/channel/ledger';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import type { HealthChild } from '~/lib/health/match';
import { loadSuppressedCheckpointRefs } from '~/lib/health/reply';
import { checkpointToldKey } from '~/lib/health/told';
import { localParts } from '~/lib/loop/prefs';
import { type AbortedWindow, providerPreflight } from '~/lib/monitoring/provider-health';
import { voiceClient } from '~/lib/loop/voice/compose';
import { weekWindow } from '~/lib/plan/spine';
import { matchRegistrationWindows } from '~/lib/registration/match-registration-windows';
import { loadClaimedWindowIds } from '~/lib/registration/sequence/claims';
import { type WeatherPort, createOpenMeteoWeather } from '~/lib/weather/open-meteo';
import { type Nudge, decideNudge } from './nudge-decide';
import { NUDGE_OPT_OUT, composeNudgeMessage } from './nudge-voice';

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

export const F14_ENABLED_ENV = 'F14_ENABLED';
export const F14_ALLOWLIST_ENV = 'F14_FAMILY_ALLOWLIST';

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

/**
 * The dark-launch gate. STRICT equality on the literal 'true': `vercel env add` from a
 * piped `echo` stores a TRAILING NEWLINE, so a value that prints as `true` is really
 * `'true\n'` — a truthiness check would read that as ON and ship an unprompted SMS
 * campaign nobody armed. Strict comparison fails closed on exactly that shape.
 */
export function f14Enabled(): boolean {
  return process.env[F14_ENABLED_ENV] === 'true';
}

/** The comma-separated family ids allowed through while the flag is off. */
export function f14Allowlist(): Set<string> {
  return new Set(
    (process.env[F14_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export function f14EnabledFor(familyId: string): boolean {
  return f14Enabled() || f14Allowlist().has(familyId);
}

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

export interface NudgeLedgerWrite {
  familyId: string;
  parentUserId: string;
  channel: 'sms';
  category: 'nudge';
  templateKey: string;
  dedupeKey: string;
  status: 'sent';
  providerMessageId: string;
  sentAt: Date;
}

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
  loadCandidates(database: Database, familyId: string): Promise<RadarCandidate[]>;
  loadWindows(database: Database, areaCoarse: string): Promise<RegistrationWindow[]>;
  /** Health checkpoints this family must not be raised about again (VIL-243 · M8). */
  loadSuppressedCheckpoints(database: Database, familyId: string): Promise<Set<string>>;
  /** Registration windows an M7 sequence (VIL-242) is already preparing this family
   * for — the sequence announces those itself, on its own ladder. */
  loadClaimedWindowIds(database: Database, familyId: string): Promise<Set<string>>;
  weather: WeatherPort;
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
  failed: number;
  held: Record<ProactiveHoldReason, number>;
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
    failed: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
  };
}

function cohortOf(family: NudgeFamily, now: Date): NudgeCohort {
  const ageHours = (now.getTime() - family.provisionedAt.getTime()) / 3_600_000;
  return ageHours <= ONBOARDING_COHORT_HOURS ? 'onboarding_48h' : 'weekly_rhythm';
}

/**
 * A nudge's natural identity, so the hourly cron can fire twice in a slot (or twice in
 * a week) and send once. A registration nudge is one per family per WINDOW — the same
 * date is never announced twice, ever. A weather swap is one per family per WEEK, keyed
 * on the family-local Monday.
 */
export function dedupeKeyFor(nudge: Nudge, familyId: string, now: Date, timeZone: string): string {
  if (nudge.kind === 'registration') {
    return `nudge:${familyId}:registration:${nudge.windowRef.id}`;
  }
  if (nudge.kind === 'health_checkpoint') {
    // A health nudge's send-idempotency key IS its told-marker (lib/health/told.ts), so
    // this row tells every other surface what this family has heard. The ref the MATCHER
    // minted is carried through untouched: per child for a one-time visit, per household
    // per school year for the annual records check.
    return checkpointToldKey(familyId, nudge.ref);
  }
  return `nudge:${familyId}:weather_swap:${weekWindow(now, timeZone).startKey}`;
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
): Promise<Nudge | null> {
  const childRows = await deps.loadChildren(database, family.familyId);
  const { children, teenChildIds, healthChildren } = splitByStage(childRows, now);
  // A family with no children on file has nothing any nudge class could rest on.
  if (healthChildren.length === 0) return null;

  const area = family.areaCoarse;
  // A household with no under-13s can only ever receive a health checkpoint, so the
  // village read, the registration read and the outbound weather call are all spend on
  // a decision that is already made.
  const weekendPossible = children.length > 0;
  const [candidates, windowRows, weather, suppressedCheckpointRefs, claimedWindowIds] =
    await Promise.all([
      weekendPossible ? deps.loadCandidates(database, family.familyId) : Promise.resolve([]),
      area && weekendPossible ? deps.loadWindows(database, area) : Promise.resolve([]),
      // Weather is an input, never a blocker: the port swallows its own failures.
      area && weekendPossible
        ? deps.weather.getDailyOutlook(area, WEATHER_DAYS).catch(() => [])
        : Promise.resolve([]),
      deps.loadSuppressedCheckpoints(database, family.familyId),
      deps.loadClaimedWindowIds(database, family.familyId),
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

  return decideNudge({
    children,
    candidates,
    windows,
    weather,
    teenChildIds,
    healthChildren,
    areaCoarse: area,
    suppressedCheckpointRefs,
    claimedWindowIds,
    now,
    timeZone: family.timeZone,
  });
}

type FamilyOutcome =
  | { kind: 'held'; reason: ProactiveHoldReason }
  | { kind: 'quiet' }
  | { kind: 'deduped' }
  | { kind: 'sent' };

async function runForFamily(
  database: Database,
  family: NudgeFamily,
  deps: NudgeRunDeps,
  now: Date,
): Promise<FamilyOutcome> {
  const verdict = await assertProactiveSendAllowed(
    { familyId: family.familyId, parentUserId: family.parentUserId, kind: 'nudge', now },
    deps.buildGate(database),
  );
  if (!verdict.allowed) return { kind: 'held', reason: verdict.reason };

  const cohort = cohortOf(family, now);
  const nudge = await decideForFamily(database, family, deps, now);
  if (!nudge) {
    // Silence is the outcome, and it is recorded: an absent row is indistinguishable
    // from a family the sweep never looked at, and the difference is the whole metric.
    await deps.audit(database, {
      familyId: family.familyId,
      actor: 'system',
      actionTaken: 'proactive_nudge_skipped',
      targetTable: 'families',
      targetId: family.familyId,
      after: { reason: 'nothing_worth_saying', cohort },
    });
    return { kind: 'quiet' };
  }

  const dedupeKey = dedupeKeyFor(nudge, family.familyId, now, family.timeZone);
  // Checked BEFORE the model call: a re-fired cron must cost nothing.
  if (await deps.dedupeActive(database, dedupeKey)) return { kind: 'deduped' };

  const message = await composeNudgeMessage(nudge, {
    familyId: family.familyId,
    database,
    client: deps.client,
  });

  const to = await deps.resolveSendablePhone(database, family.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`runNudgeCron: no send target for parent ${family.parentUserId}`);
  }

  const { providerMessageId } = await deps.transport.send({
    to,
    body: `${message}\n\n${NUDGE_OPT_OUT}`,
  });

  const messageId = await deps.recordSend(database, {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    channel: 'sms',
    category: 'nudge',
    templateKey: `proactive_nudge:${nudge.kind}`,
    dedupeKey,
    status: 'sent',
    providerMessageId,
    sentAt: now,
  });
  await deps.audit(database, {
    familyId: family.familyId,
    actor: 'system',
    actionTaken: 'proactive_nudge_sent',
    targetTable: 'channel_messages',
    targetId: messageId,
    // Enum-shaped provenance only — never the rendered body (rule #1). A health nudge
    // also names its checkpoint (a reviewed table constant, never PII), so the trail
    // says WHICH errand was raised without a join back to the ledger row's dedupe key.
    after: {
      kind: nudge.kind,
      cohort,
      ...(nudge.kind === 'health_checkpoint' ? { checkpointId: nudge.checkpointRef.id } : {}),
    },
  });

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
  return { kind: 'sent' };
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
      if (outcome.kind === 'held') result.held[outcome.reason] += 1;
      else result[outcome.kind] += 1;
    } catch (err) {
      // One family's bad data must not silence every family after it.
      result.failed += 1;
      console.error({ err, familyId: family.familyId }, 'nudge: family sweep failed');
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
        lte(
          schema.families.createdAt,
          new Date(now.getTime() - MIN_FAMILY_AGE_HOURS * 3_600_000),
        ),
      ),
    );
  return rows;
}

async function readNudgeChildren(
  database: Database,
  familyId: string,
): Promise<NudgeChildRow[]> {
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
    loadCandidates: (database, familyId) => readVillageCandidates(database, familyId),
    loadWindows: (database, areaCoarse) => readRegistrationWindows(database, areaCoarse),
    loadSuppressedCheckpoints: (database, familyId) =>
      loadSuppressedCheckpointRefs(database, familyId),
    loadClaimedWindowIds: (database, familyId) => loadClaimedWindowIds(database, familyId),
    weather: createOpenMeteoWeather(),
    buildGate: buildOutboundGatePorts,
    dedupeActive: (database, dedupeKey) => dedupeActive(dedupeKey, database),
    resolveSendablePhone,
    recordSend: async (database, write) => {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({ ...write, direction: 'out' })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('runNudgeCron: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row);
    },
    transport: createTwilioTransport(),
    client: voiceClient(),
    fulfillCommitment,
  };
}
