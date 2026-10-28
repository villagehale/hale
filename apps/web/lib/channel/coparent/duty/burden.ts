import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, gte } from 'drizzle-orm';
import { writeFact } from '~/lib/memory/facts';
import { dutyCopyMayLeave, dutyTitleMayBeSpoken } from './copy';
import {
  DUTY_BURDEN_ANSWER_TODO,
  DUTY_DEFAULT_OWNER_TODO,
  DUTY_LOPSIDED_CONSENT_TODO,
  DUTY_LOPSIDED_NUDGE_TODO,
} from './placeholders';
import {
  coparentDutyBurdenSurfaceEnabled,
  coparentDutyLopsidedEnabled,
  coparentDutyMemoryEnabled,
} from './flag';
import type { DutyOwner, DutyRole } from './model';

/**
 * VIL-383 — internal rolling duty counts.
 *
 * Stored on a logistic fact. Not spoken unless a parent asks and the
 * surface flag is exactly `true` and Design has replaced the placeholder.
 * The placeholder has no digits, so a count cannot ride out inside it.
 * The lopsided nudge is a second flag, default off, and this module has
 * no sender.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EIGHT_WEEKS_MS = 8 * WEEK_MS;
const SIX_WEEKS_MS = 6 * WEEK_MS;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
export const DUTY_BURDEN_FACT_KEY = 'duty-burden/rolling';
export const DUTY_LOPSIDED_CONSENT_KEY = 'duty-burden/lopsided-consent';

export interface BurdenCounts {
  userId: string;
  dropoff: number;
  pickup: number;
  attend: number;
}

export interface RecurringTakes {
  key: string;
  userId: string;
  takes: number;
  speakable: boolean;
}

interface DutyRow {
  factKey: string;
  validFrom: Date;
  role: DutyRole;
  owner: Extract<DutyOwner, { kind: 'parent' }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function recurrenceKey(factKey: string): { key: string; speakable: boolean } | null {
  const match = /^duty\/([^/]+)\/(dropoff|pickup|attend)$/.exec(factKey);
  if (!match?.[1] || !match[2]) return null;
  let subject = match[1];
  try {
    subject = decodeURIComponent(subject);
  } catch {
    // keep the raw segment
  }
  const title = /^who-takes\/[^/]+\/(.+)$/.exec(subject)?.[1] ?? subject;
  let decoded = title;
  try {
    decoded = decodeURIComponent(title);
  } catch {
    decoded = title;
  }
  const speakable = dutyTitleMayBeSpoken(decoded);
  const raw = `${decoded.toLowerCase()}|${match[2]}`;
  return {
    key: speakable
      ? raw
      : `h:${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`,
    speakable,
  };
}

function readDuty(factKey: string, value: unknown, validFrom: Date): DutyRow | null {
  const row = asRecord(value);
  if (!row || row.kind !== 'duty' || row.status !== 'confirmed') return null;
  const owner = row.owner as DutyOwner | null;
  if (!owner || owner.kind !== 'parent') return null;
  if (row.role !== 'dropoff' && row.role !== 'pickup' && row.role !== 'attend') return null;
  return { factKey, validFrom, role: row.role, owner };
}

export function rollingBurden(rows: readonly DutyRow[]): {
  counts: BurdenCounts[];
  recurring: RecurringTakes[];
} {
  const byUser = new Map<string, BurdenCounts>();
  const seenFact = new Set<string>();
  const recurring = new Map<string, RecurringTakes>();
  for (const row of rows) {
    if (seenFact.has(row.factKey)) continue;
    seenFact.add(row.factKey);
    const counts = byUser.get(row.owner.userId) ?? {
      userId: row.owner.userId,
      dropoff: 0,
      pickup: 0,
      attend: 0,
    };
    counts[row.role] += 1;
    byUser.set(row.owner.userId, counts);
    const recur = recurrenceKey(row.factKey);
    if (!recur) continue;
    const id = `${recur.key}|${row.owner.userId}`;
    const takes = recurring.get(id) ?? {
      key: recur.key,
      userId: row.owner.userId,
      takes: 0,
      speakable: recur.speakable,
    };
    takes.takes += 1;
    recurring.set(id, takes);
  }
  return { counts: [...byUser.values()], recurring: [...recurring.values()] };
}

export function asksBurden(text: string): boolean {
  return /\b(who(?:'s| has) done more|how many (?:pickups|drop-?offs)|mental load|burden)\b/i.test(
    text,
  );
}

/** The answer that would be spoken. It does not include the counts. */
export function burdenAnswerText(): { text: string; mayLeave: false; includesCounts: false } {
  const text = DUTY_BURDEN_ANSWER_TODO;
  return {
    text,
    mayLeave: false,
    includesCounts: false,
  };
}

export function burdenMayLeave(): boolean {
  return coparentDutyBurdenSurfaceEnabled() && dutyCopyMayLeave(DUTY_BURDEN_ANSWER_TODO);
}

export function defaultOwnerOffer(recurring: readonly RecurringTakes[]): {
  userId: string;
  takes: number;
  text: string;
  mayLeave: false;
} | null {
  const hit = recurring.find((row) => row.takes >= 3);
  if (!hit) return null;
  return {
    userId: hit.userId,
    takes: hit.takes,
    text: DUTY_DEFAULT_OWNER_TODO,
    mayLeave: false,
  };
}

export interface LopsidedInput {
  quiet: boolean;
  consent: 'unknown' | 'asked' | 'granted' | 'refused';
  lastSentAt: Date | null;
  now: Date;
  sample: number;
  leaderShare: number;
}

export function decideLopsidedNudge(input: LopsidedInput): {
  send: false;
  reason:
    | 'flag_off'
    | 'quiet_hours'
    | 'refused'
    | 'needs_consent'
    | 'below_threshold'
    | 'monthly_cap'
    | 'placeholder';
  text: null;
} {
  if (!coparentDutyLopsidedEnabled()) return { send: false, reason: 'flag_off', text: null };
  if (input.quiet) return { send: false, reason: 'quiet_hours', text: null };
  if (input.consent === 'refused') return { send: false, reason: 'refused', text: null };
  if (input.consent !== 'granted') return { send: false, reason: 'needs_consent', text: null };
  if (input.sample < 6 || input.leaderShare < 0.75) {
    return { send: false, reason: 'below_threshold', text: null };
  }
  if (input.lastSentAt && input.now.getTime() - input.lastSentAt.getTime() < MONTH_MS) {
    return { send: false, reason: 'monthly_cap', text: null };
  }
  if (!dutyCopyMayLeave(DUTY_LOPSIDED_NUDGE_TODO) || /\d/.test(DUTY_LOPSIDED_NUDGE_TODO)) {
    return { send: false, reason: 'placeholder', text: null };
  }
  return { send: false, reason: 'placeholder', text: null };
}

export function lopsidedConsentCopy(): string {
  return DUTY_LOPSIDED_CONSENT_TODO;
}

export async function noteDutyBurden(
  database: Database,
  input: { familyId: string; now: Date },
): Promise<{ counts: BurdenCounts[]; recurring: RecurringTakes[] } | null> {
  if (!coparentDutyMemoryEnabled()) return null;
  if (typeof database.select !== 'function') return null;
  const since = new Date(input.now.getTime() - EIGHT_WEEKS_MS);
  const rows = await database
    .select({
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      validFrom: schema.familyMemoryFacts.validFrom,
      familyId: schema.familyMemoryFacts.familyId,
      factType: schema.familyMemoryFacts.factType,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        eq(schema.familyMemoryFacts.factType, 'logistic'),
        gte(schema.familyMemoryFacts.validFrom, since),
      ),
    );
  const duties: DutyRow[] = [];
  for (const row of rows) {
    if (row.familyId !== input.familyId || row.factType !== 'logistic') continue;
    if (row.validFrom.getTime() < since.getTime()) continue;
    const duty = readDuty(row.factKey, row.factValue, row.validFrom);
    if (!duty) continue;
    if (input.now.getTime() - duty.validFrom.getTime() > EIGHT_WEEKS_MS) continue;
    duties.push(duty);
  }
  const summary = rollingBurden(duties);
  const sixSince = input.now.getTime() - SIX_WEEKS_MS;
  const recent = duties.filter((row) => row.validFrom.getTime() >= sixSince);
  const recentSummary = rollingBurden(recent);
  const total = recentSummary.counts.reduce(
    (sum, row) => sum + row.dropoff + row.pickup + row.attend,
    0,
  );
  const leader = recentSummary.counts.reduce(
    (best, row) => Math.max(best, row.dropoff + row.pickup + row.attend),
    0,
  );
  const offer = defaultOwnerOffer(summary.recurring);
  await writeFact(database, {
    familyId: input.familyId,
    childId: null,
    factType: 'logistic',
    factKey: DUTY_BURDEN_FACT_KEY,
    factValue: {
      schemaVersion: 1,
      kind: 'duty_burden',
      windowWeeks: 8,
      counts: summary.counts,
      recurring: summary.recurring.map((row) => ({
        userId: row.userId,
        takes: row.takes,
        speakable: row.speakable,
      })),
      lopsidedSample: total,
      lopsidedLeaderShare: total === 0 ? 0 : leader / total,
      defaultOwnerWithheld: offer ? 'placeholder' : null,
    },
    confidence: 1,
    inferredBy: 'coparent_duty_burden',
    validFrom: input.now,
  });
  if (offer) {
    console.info({ withheld: 'placeholder' }, 'duty memory: default owner not offered');
  }
  return summary;
}

