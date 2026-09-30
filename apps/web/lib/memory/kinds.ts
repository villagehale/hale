/**
 * VIL-391 — how long a family memory fact should steer Hale, and where it came from.
 *
 * The flag is off unless FAMILY_MEMORY_KINDS_ENABLED is exactly `true`. `TRUE`
 * and `true\n` stay off: a piped env write stores a trailing newline, and a
 * truthiness check would arm this. Parent-facing sentences are TODO-Design
 * placeholders for Sloane. They leave this module only when the flag is on
 * AND FAMILY_MEMORY_KINDS_COPY_LOCKED is exactly `true`.
 *
 * VIL-388 (exportable family memory) has no snapshot builder in this repo.
 * {@link toFamilyMemoryExportFact} is the hook that snapshot should call so
 * kind and source travel with each fact. Do not invent a second export shape.
 */

export const FAMILY_MEMORY_KINDS_ENABLED_ENV = 'FAMILY_MEMORY_KINDS_ENABLED';
export const FAMILY_MEMORY_KINDS_COPY_LOCKED_ENV = 'FAMILY_MEMORY_KINDS_COPY_LOCKED';

export type MemoryKind = 'lasting' | 'temporary' | 'one_off';
export type MemorySource = 'parent_message' | 'calendar' | 'receipt' | 'inferred' | 'legacy';
export type PromotionSignal = 'repeat_ask' | 'booking' | 'positive_feedback';
export type MemoryKindLanguage = 'en' | 'fr';

export type MemoryKindEnv = Record<string, string | undefined>;

const LASTING_KEYS = new Set([
  'age',
  'dateofbirth',
  'dob',
  'district',
  'neighbourhood',
  'neighborhood',
  'language',
  'homelanguage',
  'weekdaycare',
  'pickupowner',
  'dropoffowner',
  'daycarepickupowner',
]);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TERM_MS = 120 * 24 * 60 * 60 * 1000;

/**
 * Placeholder copy for Sloane. ASCII only, EN and FR. Never a sentence a
 * parent should read. The transport gate below is what keeps them unsent.
 */
export const MEMORY_KIND_COPY = {
  en: {
    recall: 'TODO-Design: what Hale knows (EN)',
    forgotten: 'TODO-Design: forgot a memory (EN)',
    corrected: 'TODO-Design: corrected a memory (EN)',
    nothing: 'TODO-Design: nothing to forget (EN)',
    refused: 'TODO-Design: that memory stays (EN)',
    groupSync: 'TODO-Design: group heard a memory change (EN)',
  },
  fr: {
    recall: 'TODO-Design: what Hale knows (FR)',
    forgotten: 'TODO-Design: forgot a memory (FR)',
    corrected: 'TODO-Design: corrected a memory (FR)',
    nothing: 'TODO-Design: nothing to forget (FR)',
    refused: 'TODO-Design: that memory stays (FR)',
    groupSync: 'TODO-Design: group heard a memory change (FR)',
  },
} as const;

export type MemoryKindCopyKey = keyof (typeof MEMORY_KIND_COPY)['en'];

export function familyMemoryKindsEnabled(env: MemoryKindEnv = process.env): boolean {
  return env[FAMILY_MEMORY_KINDS_ENABLED_ENV] === 'true';
}

export function familyMemoryKindsCopyLocked(env: MemoryKindEnv = process.env): boolean {
  return env[FAMILY_MEMORY_KINDS_COPY_LOCKED_ENV] === 'true';
}

export function memoryKindBodies(): string[] {
  const bodies: string[] = [];
  for (const language of ['en', 'fr'] as const) {
    for (const key of Object.keys(MEMORY_KIND_COPY.en) as MemoryKindCopyKey[]) {
      bodies.push(MEMORY_KIND_COPY[language][key]);
    }
  }
  return bodies;
}

export function memoryKindCopy(language: MemoryKindLanguage, key: MemoryKindCopyKey): string {
  return MEMORY_KIND_COPY[language][key];
}

export function memoryKindLanguage(primaryLanguage: string | null | undefined): MemoryKindLanguage {
  return primaryLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/**
 * The only way a placeholder may be handed to a transport. Both gates are
 * strict `=== 'true'`. Anything else names why it was withheld.
 */
export function deliverMemoryKindCopy(
  body: string,
  env: MemoryKindEnv = process.env,
):
  | { deliver: true; body: string }
  | { deliver: false; skipped: 'flag_off' | 'copy_not_locked' } {
  if (!familyMemoryKindsEnabled(env)) return { deliver: false, skipped: 'flag_off' };
  if (!familyMemoryKindsCopyLocked(env)) return { deliver: false, skipped: 'copy_not_locked' };
  return { deliver: true, body };
}

export async function sendMemoryKindReply(
  send: (body: string) => Promise<unknown>,
  body: string,
  env: MemoryKindEnv = process.env,
): Promise<{ sent: boolean; skipped: 'flag_off' | 'copy_not_locked' | null }> {
  const gated = deliverMemoryKindCopy(body, env);
  if (!gated.deliver) return { sent: false, skipped: gated.skipped };
  await send(gated.body);
  return { sent: true, skipped: null };
}

export function normMemoryKey(factKey: string): string {
  return factKey.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isLastingFactKey(factKey: string): boolean {
  return LASTING_KEYS.has(normMemoryKey(factKey));
}

/** A writer that already knows the span. `term` is about four months. */
export function temporaryExpiry(now: Date, span: 'week' | 'term'): Date {
  const ms = span === 'week' ? WEEK_MS : TERM_MS;
  return new Date(now.getTime() + ms);
}

export interface LiveMemoryTyping {
  kind: MemoryKind;
  source: MemorySource;
  signalCount: number;
}

export interface ClassifiedMemory {
  kind: MemoryKind;
  source: MemorySource;
  signalCount: number;
  expiresAt: Date | null;
}

export interface ClassifyMemoryInput {
  factType: string;
  factKey: string;
  source: MemorySource;
  expiresAt?: Date | null;
  existing?: LiveMemoryTyping | null;
  /** Set only when THIS write is itself a promotion signal. */
  signal?: PromotionSignal | null;
}

/**
 * Place one write. An inferred preference or routine stays `one_off` until a
 * second signal (a repeat of the same fact, a booking, or positive feedback).
 * Age, district, language, and recurring-duty keys are lasting on the first
 * write. A supplied expiry makes the row temporary.
 */
export function classifyMemoryWrite(input: ClassifyMemoryInput): ClassifiedMemory {
  const source = input.source;
  if (input.expiresAt) {
    return {
      kind: 'temporary',
      source,
      signalCount: input.existing?.signalCount ?? 0,
      expiresAt: input.expiresAt,
    };
  }
  if (isLastingFactKey(input.factKey)) {
    return {
      kind: 'lasting',
      source,
      signalCount: input.existing?.signalCount ?? 0,
      expiresAt: null,
    };
  }
  if (source === 'inferred' && (input.factType === 'preference' || input.factType === 'routine')) {
    const prior = input.existing?.source === 'inferred' ? input.existing.signalCount : 0;
    const repeat =
      input.existing?.kind === 'one_off' && input.existing.source === 'inferred';
    const thisIsSignal = Boolean(input.signal) || repeat;
    const signalCount = prior + (thisIsSignal ? 1 : 0);
    if (thisIsSignal && signalCount >= 1) {
      return { kind: 'lasting', source: 'inferred', signalCount, expiresAt: null };
    }
    return { kind: 'one_off', source: 'inferred', signalCount: 0, expiresAt: null };
  }
  if (source === 'calendar') {
    return { kind: 'one_off', source, signalCount: 0, expiresAt: null };
  }
  return {
    kind: 'lasting',
    source,
    signalCount: input.existing?.signalCount ?? 0,
    expiresAt: null,
  };
}

/**
 * A later booking, repeat, or positive word about an inferred one-off.
 * The inference itself is not a signal: `signalCount` starts at 0, and the
 * first of these promotes the row to lasting.
 */
export function applyPromotionSignal(
  entry: LiveMemoryTyping,
  _signal: PromotionSignal,
): { kind: MemoryKind; signalCount: number; promoted: boolean } {
  if (entry.source !== 'inferred' || entry.kind !== 'one_off') {
    return { kind: entry.kind, signalCount: entry.signalCount, promoted: false };
  }
  return { kind: 'lasting', signalCount: entry.signalCount + 1, promoted: true };
}

export function isExpiredTemporary(
  row: { memoryKind: string | null | undefined; expiresAt: Date | string | null | undefined },
  now: Date,
): boolean {
  if (row.memoryKind !== 'temporary') return false;
  if (!row.expiresAt) return true;
  const expires = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  return Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime();
}

/**
 * Recommendation inputs. Flag off: every live row, exactly as before.
 * Flag on: lasting, and temporary rows that have not reached `expires_at`.
 * A missing kind is treated as the backfill (`lasting`) so an older fixture
 * still counts once the flag is on.
 */
export function includeInRecommendations(
  row: { memoryKind?: string | null; expiresAt?: Date | string | null },
  now: Date,
  enabled: boolean,
): boolean {
  if (!enabled) return true;
  const kind = row.memoryKind ?? 'lasting';
  if (kind === 'one_off') return false;
  if (kind === 'temporary') {
    return !isExpiredTemporary({ memoryKind: kind, expiresAt: row.expiresAt }, now);
  }
  return kind === 'lasting';
}

export interface FamilyMemoryExportFact {
  id: string;
  factType: string;
  factKey: string;
  kind: MemoryKind;
  source: MemorySource;
  sourcedAt: string;
  expiresAt: string | null;
  /** Soft-invalidation instant (`valid_until`). Null while the row is live. */
  invalidatedAt: string | null;
}

const EXPORT_KINDS = new Set<MemoryKind>(['lasting', 'temporary', 'one_off']);
const EXPORT_SOURCES = new Set<MemorySource>([
  'parent_message',
  'calendar',
  'receipt',
  'inferred',
  'legacy',
]);

function asKind(value: string): MemoryKind {
  return EXPORT_KINDS.has(value as MemoryKind) ? (value as MemoryKind) : 'lasting';
}

function asSource(value: string): MemorySource {
  return EXPORT_SOURCES.has(value as MemorySource) ? (value as MemorySource) : 'legacy';
}

/**
 * VIL-388 hook. There is no family-memory snapshot in the repo yet (that
 * ticket is research and design). When the snapshot is built, map each
 * `family_memory_facts` row through this so kind and source are in the file.
 */
export function toFamilyMemoryExportFact(row: {
  id: string;
  factType: string;
  factKey: string;
  memoryKind?: string | null;
  memorySource?: string | null;
  sourcedAt?: Date | null;
  expiresAt?: Date | null;
  validUntil?: Date | null;
}): FamilyMemoryExportFact {
  return {
    id: row.id,
    factType: row.factType,
    factKey: row.factKey,
    kind: asKind(row.memoryKind ?? 'lasting'),
    source: asSource(row.memorySource ?? 'legacy'),
    sourcedAt: (row.sourcedAt ?? new Date(0)).toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    invalidatedAt: row.validUntil ? row.validUntil.toISOString() : null,
  };
}

export interface MemoryParentIntent {
  kind: 'recall' | 'forget' | 'correct';
  /** Forget target. Null means the latest belief ("forget that"). */
  needle: string | null;
  factKey: string | null;
  value: string | null;
}

const RECALL =
  /^(?:what do you know(?: about us)?|what does hale know|que sais-tu(?: de nous)?|que sais tu(?: de nous)?)\??$/i;
const FORGET = /^(?:forget|oublie)(?:\s+(.+))?$/i;
const CORRECT = /^(?:correct|corrige)\s+([a-z0-9_]{1,80})\s*(?::|to|a)\s+(\S(?:.*\S)?)$/i;
const FORGET_LATEST = new Set(['that', 'this', 'ca', 'cela', 'it']);

/**
 * Deterministic. No model. A sentence that is not one of these shapes is
 * not claimed, so the coach still answers it.
 */
export function parseMemoryParentIntent(body: string): MemoryParentIntent | null {
  const text = body.trim().replace(/\s+/g, ' ');
  if (!text || text.length > 240) return null;
  if (RECALL.test(text)) return { kind: 'recall', needle: null, factKey: null, value: null };
  const correction = CORRECT.exec(text);
  if (correction?.[1] && correction[2]) {
    return {
      kind: 'correct',
      needle: null,
      factKey: correction[1].toLowerCase(),
      value: correction[2].slice(0, 200),
    };
  }
  const forget = FORGET.exec(text);
  if (!forget) return null;
  const rest = forget[1]?.trim().toLowerCase() ?? '';
  if (!rest || FORGET_LATEST.has(rest)) {
    return { kind: 'forget', needle: null, factKey: null, value: null };
  }
  return { kind: 'forget', needle: rest, factKey: null, value: null };
}

export function memoryTextOverlaps(factKey: string, factValue: unknown, needle: string): boolean {
  const n = normMemoryKey(needle);
  if (n.length < 4) return false;
  const key = normMemoryKey(factKey);
  if (key.length >= 4 && (key.includes(n) || n.includes(key))) return true;
  const value = normMemoryKey(valueText(factValue));
  return value.length >= 4 && (value.includes(n) || n.includes(value));
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
