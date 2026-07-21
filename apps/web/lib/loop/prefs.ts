import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { eq, inArray } from 'drizzle-orm';

/**
 * F11 · The Sunday Loop — the pure enforcement hooks over per-parent loop
 * preferences (VIL-216 · A5). A2 (the send seam) composes these; this module owns
 * the read and the deterministic rules, never the send itself. Mirrors the shape
 * of lib/push/prefs.ts: pure async loaders with the Database injected as the last
 * argument, and a documented default for the absent-row state (a parent who never
 * opened Settings still has a well-defined loop).
 *
 * The existing notification_prefs (push booleans) and email_opt_outs (CASL digest)
 * are a SEPARATE concern and are not read here — the loop taxonomy is its own.
 *
 * Privacy (rule #1): child_name_level composes WITH the deterministic teen age
 * gate (deriveStage). It can only make a message MORE private — a 13+ child is
 * always generic, and this preference can never loosen that.
 */

export type LoopChannel = 'email' | 'sms';
export type ChildNameLevel = 'first_name' | 'relation' | 'generic';
export type LoopCategory = 'weekly_plan' | 'reminder' | 'approval' | 'alert';

export interface LoopPrefsView {
  loopChannel: LoopChannel;
  catWeeklyPlan: boolean;
  catReminder: boolean;
  catApproval: boolean;
  catAlert: boolean;
  /** Wall-clock local 'HH:MM:SS', interpreted in the parent's users.timezone. */
  quietHoursStart: string;
  quietHoursEnd: string;
  urgentBypassQuietHours: boolean;
  weeklyPlanSendTime: string;
  childNameLevel: ChildNameLevel;
}

/**
 * The documented default for a parent with no loop_prefs row (mirrors the table's
 * column defaults). Row absence is a valid state, not an error. Exported as a
 * frozen constant so the defaults live in exactly one place (no magic strings).
 */
export const DEFAULT_LOOP_PREFS: LoopPrefsView = Object.freeze({
  loopChannel: 'email',
  catWeeklyPlan: true,
  catReminder: true,
  catApproval: true,
  catAlert: true,
  quietHoursStart: '21:30:00',
  quietHoursEnd: '07:30:00',
  urgentBypassQuietHours: true,
  weeklyPlanSendTime: '19:30:00',
  childNameLevel: 'generic',
});

/** The rendered child-identifier strings for each name level (no magic strings). */
export const CHILD_NAME_GENERIC = 'your kid';
export const CHILD_NAME_RELATION = Object.freeze({
  boy: 'your son',
  girl: 'your daughter',
  fallback: 'your child',
});

// ── Loaders ─────────────────────────────────────────────────────────────────

/** The parent's loop preferences, or the documented default when no row exists. */
export async function loadLoopPrefsView(
  userId: string,
  database: Database,
): Promise<LoopPrefsView> {
  const rows = await database
    .select({
      loopChannel: schema.loopPrefs.loopChannel,
      catWeeklyPlan: schema.loopPrefs.catWeeklyPlan,
      catReminder: schema.loopPrefs.catReminder,
      catApproval: schema.loopPrefs.catApproval,
      catAlert: schema.loopPrefs.catAlert,
      quietHoursStart: schema.loopPrefs.quietHoursStart,
      quietHoursEnd: schema.loopPrefs.quietHoursEnd,
      urgentBypassQuietHours: schema.loopPrefs.urgentBypassQuietHours,
      weeklyPlanSendTime: schema.loopPrefs.weeklyPlanSendTime,
      childNameLevel: schema.loopPrefs.childNameLevel,
    })
    .from(schema.loopPrefs)
    .where(eq(schema.loopPrefs.userId, userId))
    .limit(1);
  return rows[0] ?? DEFAULT_LOOP_PREFS;
}

/**
 * Batch counterpart of loadLoopPrefsView: the prefs for many parents in ONE `inArray`
 * query, as a Map keyed by userId. A userId with NO row is absent from the map — the
 * caller applies DEFAULT_LOOP_PREFS (row absence is a valid state), so the map carries
 * only the rows that exist. Lets a cron sweep read every parent's prefs in one round
 * trip instead of an N+1 per-family read.
 */
export async function loadLoopPrefsViewsByUserIds(
  userIds: string[],
  database: Database,
): Promise<Map<string, LoopPrefsView>> {
  if (userIds.length === 0) return new Map();
  const rows = await database
    .select({
      userId: schema.loopPrefs.userId,
      loopChannel: schema.loopPrefs.loopChannel,
      catWeeklyPlan: schema.loopPrefs.catWeeklyPlan,
      catReminder: schema.loopPrefs.catReminder,
      catApproval: schema.loopPrefs.catApproval,
      catAlert: schema.loopPrefs.catAlert,
      quietHoursStart: schema.loopPrefs.quietHoursStart,
      quietHoursEnd: schema.loopPrefs.quietHoursEnd,
      urgentBypassQuietHours: schema.loopPrefs.urgentBypassQuietHours,
      weeklyPlanSendTime: schema.loopPrefs.weeklyPlanSendTime,
      childNameLevel: schema.loopPrefs.childNameLevel,
    })
    .from(schema.loopPrefs)
    .where(inArray(schema.loopPrefs.userId, userIds));
  const byUser = new Map<string, LoopPrefsView>();
  for (const { userId, ...view } of rows) {
    byUser.set(userId, view);
  }
  return byUser;
}

const CATEGORY_FLAG: Record<LoopCategory, keyof LoopPrefsView> = {
  weekly_plan: 'catWeeklyPlan',
  reminder: 'catReminder',
  approval: 'catApproval',
  alert: 'catAlert',
};

/** Whether the parent has this loop category enabled (default on when untouched). */
export function categoryEnabled(view: LoopPrefsView, category: LoopCategory): boolean {
  return view[CATEGORY_FLAG[category]] === true;
}

/** DB-reading convenience: whether the parent has this category enabled. */
export async function loopCategoryEnabled(
  userId: string,
  category: LoopCategory,
  database: Database,
): Promise<boolean> {
  const view = await loadLoopPrefsView(userId, database);
  return categoryEnabled(view, category);
}

// ── Child-name privacy (composes with the teen age gate) ─────────────────────

/**
 * The EFFECTIVE name level for a child: the parent's preference, unless the
 * deterministic teen age gate (deriveStage ≥ 13y = 'teenager', rule #1) forces
 * the most-private 'generic'. Pure and age-derived — never the classifier flag.
 * A teen can only be made MORE private by this; never looser.
 */
export function resolveChildNameLevel(
  dateOfBirth: string | Date,
  prefLevel: ChildNameLevel,
  now: Date = new Date(),
): ChildNameLevel {
  if (deriveStage(dateOfBirth, now) === 'teenager') {
    return 'generic';
  }
  return prefLevel;
}

/** The identifier string for an already-resolved name level. Never emits the
 * first name under 'generic' — that is the property the template tests assert. */
export function renderChildName(
  child: { name: string; gender: string },
  level: ChildNameLevel,
): string {
  switch (level) {
    case 'first_name':
      return child.name;
    case 'relation':
      if (child.gender === 'boy') return CHILD_NAME_RELATION.boy;
      if (child.gender === 'girl') return CHILD_NAME_RELATION.girl;
      return CHILD_NAME_RELATION.fallback;
    default:
      return CHILD_NAME_GENERIC;
  }
}

/**
 * The child identifier A2/templates use: resolve the effective level (teen gate)
 * then render it. A 13+ child NEVER yields a first name here, regardless of the
 * parent's preference.
 */
export function loopChildName(
  child: { name: string; gender: string; dateOfBirth: string | Date },
  prefLevel: ChildNameLevel,
  now: Date = new Date(),
): string {
  return renderChildName(child, resolveChildNameLevel(child.dateOfBirth, prefLevel, now));
}

// ── Quiet hours + weekly send time (wall-clock in the parent's timezone) ──────

/** 'HH:MM' or 'HH:MM:SS' → minutes since local midnight. */
function timeToMinutes(hms: string): number {
  const [h, m] = hms.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * The parent's LOCAL calendar weekday (0=Sun…6=Sat) and minutes-since-midnight
 * for an instant, computed in their IANA timezone. DST-safe: Intl resolves the
 * zone offset for the instant, so the same UTC moment maps to the correct local
 * wall clock in winter (EST) and summer (EDT).
 */
export function localParts(now: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // en-CA with hour12:false renders local midnight as '24' — normalize to 0.
  const hour = Number(get('hour')) % 24;
  const minutes = hour * 60 + Number(get('minute'));
  // The calendar weekday of a local Y-M-D is timezone-independent once resolved.
  const weekday = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`).getUTCDay();
  return { weekday, minutes };
}

/**
 * Whether `now` falls inside the parent's quiet-hours window, in their timezone.
 * Handles the common midnight-wrapping window (e.g. 21:30 → 07:30). A window whose
 * start equals its end means "no quiet hours" (deliver anytime).
 */
export function isWithinQuietHours(
  now: Date,
  timeZone: string,
  start: string,
  end: string,
): boolean {
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  if (startMin === endMin) return false;
  const { minutes } = localParts(now, timeZone);
  return startMin < endMin
    ? minutes >= startMin && minutes < endMin
    : minutes >= startMin || minutes < endMin;
}

/**
 * Whether a message may be delivered to this parent right now. Normal messages
 * defer out of quiet hours; a time-sensitive message (T-1h reminder, safety
 * alert) may cross the window only when the parent left the urgent-bypass toggle
 * on. A2 still checks the per-category enable separately.
 */
export function deliverableNow(
  view: LoopPrefsView,
  now: Date,
  timeZone: string,
  timeSensitive: boolean,
): boolean {
  if (!isWithinQuietHours(now, timeZone, view.quietHoursStart, view.quietHoursEnd)) {
    return true;
  }
  return timeSensitive && view.urgentBypassQuietHours;
}

/**
 * The local weekday the weekly plan is sent on: the evening BEFORE the parent's
 * week starts (users.weekStartDay, 0=Sun/1=Mon). A Monday-start week → Sunday,
 * the "Sunday Loop" default.
 */
export function weeklyPlanWeekday(weekStartDay: number): number {
  return (weekStartDay + 6) % 7;
}

/**
 * Whether `now` is exactly the parent's weekly-plan send moment — their local
 * send weekday at their local send time. Two parents in different timezones each
 * match at their own UTC instant (their local Sunday 19:30), DST-correctly. The
 * A2 cron chooses how to align its cadence to this moment.
 */
export function isWeeklyPlanMoment(
  view: LoopPrefsView,
  now: Date,
  timeZone: string,
  weekStartDay: number,
): boolean {
  const { weekday, minutes } = localParts(now, timeZone);
  return (
    weekday === weeklyPlanWeekday(weekStartDay) &&
    minutes === timeToMinutes(view.weeklyPlanSendTime)
  );
}

// ── Writes (validation + the audited upsert) ─────────────────────────────────
// These live here, free of the auth/session imports, so the round-trip + audit
// shape is unit-testable; lib/settings/loop-prefs.ts wraps them with the
// auth/family resolution and degradation contract.

/** One writable field + its value, as a discriminated union so each field's value
 * type is checked at compile time; runtime validation guards the untrusted edges. */
export type LoopPrefUpdate =
  | { field: 'loopChannel'; value: LoopChannel }
  | {
      field:
        | 'catWeeklyPlan'
        | 'catReminder'
        | 'catApproval'
        | 'catAlert'
        | 'urgentBypassQuietHours';
      value: boolean;
    }
  | { field: 'quietHoursStart' | 'quietHoursEnd' | 'weeklyPlanSendTime'; value: string }
  | { field: 'childNameLevel'; value: ChildNameLevel };

const LOOP_CHANNELS: readonly LoopChannel[] = ['email', 'sms'];
const CHILD_NAME_LEVELS: readonly ChildNameLevel[] = ['first_name', 'relation', 'generic'];
// 24h wall-clock 'HH:MM' or 'HH:MM:SS'; the send day/zone come from the user row.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** The only columns a preference update may write — nothing else (e.g. userId,
 * timestamps) can be reached through the untrusted (field, value) edge. */
const WRITABLE_FIELDS = new Set<LoopPrefUpdate['field']>([
  'loopChannel',
  'catWeeklyPlan',
  'catReminder',
  'catApproval',
  'catAlert',
  'urgentBypassQuietHours',
  'quietHoursStart',
  'quietHoursEnd',
  'weeklyPlanSendTime',
  'childNameLevel',
]);

/** True when the update targets a writable field AND its value is well-formed for
 * that field (untrusted input from the server action + the mobile route). */
export function isValidLoopPrefUpdate(update: LoopPrefUpdate): boolean {
  if (!WRITABLE_FIELDS.has(update.field)) return false;
  switch (update.field) {
    case 'loopChannel':
      return LOOP_CHANNELS.includes(update.value);
    case 'childNameLevel':
      return CHILD_NAME_LEVELS.includes(update.value);
    case 'quietHoursStart':
    case 'quietHoursEnd':
    case 'weeklyPlanSendTime':
      return typeof update.value === 'string' && TIME_RE.test(update.value);
    default:
      return typeof update.value === 'boolean';
  }
}

/**
 * The upsert + audit write for one field, in a single transaction (rule #6: every
 * preference change leaves an immutable audit_log row). The audit carries only the
 * field name + new value — never child content (rule #1).
 */
export async function writeLoopPref(
  database: Database,
  userId: string,
  familyId: string,
  update: LoopPrefUpdate,
): Promise<void> {
  // Normalize a bare 'HH:MM' to the 'HH:MM:SS' the time column round-trips.
  const value =
    typeof update.value === 'string' && update.value.length === 5
      ? `${update.value}:00`
      : update.value;

  await database.transaction(async (tx) => {
    await tx
      .insert(schema.loopPrefs)
      .values({ userId, [update.field]: value })
      .onConflictDoUpdate({
        target: schema.loopPrefs.userId,
        set: { [update.field]: value, updatedAt: new Date() },
      });

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'notification_pref_updated',
      targetTable: 'loop_prefs',
      targetId: userId,
      after: { [update.field]: value },
    });
  });
}
