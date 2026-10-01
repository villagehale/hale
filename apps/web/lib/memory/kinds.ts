/**
 * VIL-391 — how long a family memory fact should steer Hale, and where it came from.
 *
 * The flag is off unless FAMILY_MEMORY_KINDS_ENABLED is exactly `true`. `TRUE`
 * and `true\n` stay off: a piped env write stores a trailing newline, and a
 * truthiness check would arm this. Parent-facing sentences are Sloane's locked
 * copy (VIL-381). They leave this module only when the flag is on AND
 * FAMILY_MEMORY_KINDS_COPY_LOCKED is exactly `true`. Both stay default off.
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
 * Locked parent-facing copy. ASCII only. `{token}` is filled before a send.
 * French is tu/vous-neutral except where the sentence itself is fixed.
 */
export const MEMORY_KIND_COPY = {
  en: {
    recall:
      'Here\'s what I have for your family:\n{list}\nWrong or old? Text "correct <key>: <value>" or "forget <key>".',
    forgotten: 'Done, I forgot {key}.',
    corrected: 'Got it. {key} is now {value}.',
    nothing:
      'I didn\'t find anything to forget there. Text "what do you know" to see what I have, then "forget <key>".',
    refused: 'I keep that one, it\'s a record. Text "what do you know" to see what can be changed.',
    groupSync: '{who} asked me to forget something.',
  },
  fr: {
    recall:
      'Voici ce que j\'ai sur la famille :\n{list}\nPour changer : "corrige <cle> : <valeur>" ou "oublie <cle>".',
    forgotten: "C'est oublie : {key}.",
    corrected: "C'est corrige : {key} est maintenant {value}.",
    nothing: 'Rien a oublier de ce cote. "que sais-tu" montre ce que j\'ai, puis "oublie <cle>".',
    refused: 'Celle-la reste, c\'est un dossier. "que sais-tu" montre ce qui peut changer.',
    groupSync: "{who} m'a demande d'oublier quelque chose.",
  },
} as const;

/** Lines and variants the six keys above do not hold on their own. */
export const MEMORY_KIND_LINES = {
  en: {
    recallEmpty: "I don't have anything saved about your family yet.",
    parent: '- {key}: {value} ({term}, you told me)',
    calendar: '- {key}: {value} ({term}, from your calendar)',
    inferred: '- {key}: I think {value} (for now)',
    termLasting: 'lasting',
    termTemporary: 'for now',
    forgottenMany: 'Done, I forgot {n} things.',
    groupSyncCorrect: '{who} corrected something.',
  },
  fr: {
    recallEmpty: "Je n'ai encore rien note sur la famille.",
    parent: '- {key} : {value} ({term}, dit par un parent)',
    calendar: '- {key} : {value} ({term}, vu dans le calendrier)',
    inferred: "- {key} : je crois que {value} (pour l'instant)",
    termLasting: 'durable',
    termTemporary: "pour l'instant",
    forgottenMany: "C'est oublie : {n} elements.",
    groupSyncCorrect: '{who} a corrige quelque chose.',
  },
} as const;

export const MEMORY_RECALL_LINES_PER_BUBBLE = 10;

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
    for (const key of Object.keys(
      MEMORY_KIND_LINES.en,
    ) as (keyof (typeof MEMORY_KIND_LINES)['en'])[]) {
      bodies.push(MEMORY_KIND_LINES[language][key]);
    }
  }
  return bodies;
}

const MEMORY_TOKEN = /\{[a-zA-Z]+\}/;
const MEMORY_BANNED = /reply stop|unsubscribe|\b(booked|enrolled|signed up)\b/i;

export class MemoryKindCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryKindCopyError';
  }
}

function fillMemory(
  template: string,
  params: Record<string, string | null | undefined>,
  required: readonly string[],
  language: MemoryKindLanguage,
): string {
  const bag = new Map<string, string>();
  for (const key of required) {
    const value = params[key]?.trim();
    if (!value || /[{}]/.test(value)) throw new MemoryKindCopyError(`missing ${key}`);
    bag.set(key, value);
  }
  const rendered = template.replace(/\{([a-zA-Z]+)\}/g, (_match, key: string) => {
    const value = bag.get(key);
    if (!value) throw new MemoryKindCopyError(`missing ${key}`);
    return value;
  });
  if (MEMORY_TOKEN.test(rendered)) throw new MemoryKindCopyError('unrendered');
  if (language === 'fr' && [...rendered].some((char) => char.charCodeAt(0) > 0x7f)) {
    throw new MemoryKindCopyError('fr_not_ascii');
  }
  if (MEMORY_BANNED.test(rendered)) throw new MemoryKindCopyError('banned');
  return rendered;
}

export interface MemoryRecallItem {
  key: string;
  value: string;
  source: MemorySource;
  kind: MemoryKind;
}

function recallParts(language: MemoryKindLanguage): { header: string; footer: string } {
  const [header, footer] = MEMORY_KIND_COPY[language].recall.split('\n{list}\n');
  if (!header || !footer) throw new MemoryKindCopyError('recall');
  return { header, footer };
}

function recallTerm(language: MemoryKindLanguage, kind: MemoryKind): string {
  return kind === 'lasting'
    ? MEMORY_KIND_LINES[language].termLasting
    : MEMORY_KIND_LINES[language].termTemporary;
}

function recallLine(language: MemoryKindLanguage, item: MemoryRecallItem): string {
  const key = item.key.trim();
  const value = item.value.replace(/\s+/g, ' ').trim();
  if (item.source === 'inferred') {
    return fillMemory(
      MEMORY_KIND_LINES[language].inferred,
      { key, value },
      ['key', 'value'],
      language,
    );
  }
  const template =
    item.source === 'calendar'
      ? MEMORY_KIND_LINES[language].calendar
      : MEMORY_KIND_LINES[language].parent;
  return fillMemory(
    template,
    { key, value, term: recallTerm(language, item.kind) },
    ['key', 'value', 'term'],
    language,
  );
}

/**
 * Newest first. At most ten lines a bubble. The header is only on the first
 * bubble and the "wrong or old" line only on the last. An empty list is its
 * own sentence. Receipts are dropped. Inferred rows always say "I think".
 */
export function renderMemoryRecall(
  language: MemoryKindLanguage,
  items: readonly MemoryRecallItem[],
): string[] {
  const visible = items.filter(
    (item) =>
      item.source !== 'receipt' && item.key.trim().length > 0 && item.value.trim().length > 0,
  );
  if (visible.length === 0) return [MEMORY_KIND_LINES[language].recallEmpty];
  const lines = visible.map((item) => recallLine(language, item));
  const { header, footer } = recallParts(language);
  const bubbles: string[] = [];
  for (let index = 0; index < lines.length; index += MEMORY_RECALL_LINES_PER_BUBBLE) {
    const page = lines.slice(index, index + MEMORY_RECALL_LINES_PER_BUBBLE);
    const parts: string[] = [];
    if (index === 0) parts.push(header);
    parts.push(...page);
    if (index + MEMORY_RECALL_LINES_PER_BUBBLE >= lines.length) parts.push(footer);
    bubbles.push(parts.join('\n'));
  }
  return bubbles;
}

export function renderMemoryForgotten(
  language: MemoryKindLanguage,
  keys: readonly string[],
): string {
  if (keys.length === 1 && keys[0]) {
    return fillMemory(MEMORY_KIND_COPY[language].forgotten, { key: keys[0] }, ['key'], language);
  }
  if (keys.length > 1) {
    return fillMemory(
      MEMORY_KIND_LINES[language].forgottenMany,
      { n: String(keys.length) },
      ['n'],
      language,
    );
  }
  throw new MemoryKindCopyError('missing key');
}

export function renderMemoryCorrected(
  language: MemoryKindLanguage,
  key: string,
  value: string,
): string {
  return fillMemory(
    MEMORY_KIND_COPY[language].corrected,
    { key, value },
    ['key', 'value'],
    language,
  );
}

/** A statement. No value, no question. */
export function renderMemoryGroupSync(
  language: MemoryKindLanguage,
  change: 'forget' | 'correct',
  who: string,
): string {
  const template =
    change === 'correct'
      ? MEMORY_KIND_LINES[language].groupSyncCorrect
      : MEMORY_KIND_COPY[language].groupSync;
  const text = fillMemory(template, { who }, ['who'], language);
  if (text.includes('?') || text.includes(who) === false) throw new MemoryKindCopyError('group');
  return text;
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
  | { deliver: false; skipped: 'flag_off' | 'copy_not_locked' | 'unrendered' } {
  if (!familyMemoryKindsEnabled(env)) return { deliver: false, skipped: 'flag_off' };
  if (!familyMemoryKindsCopyLocked(env)) return { deliver: false, skipped: 'copy_not_locked' };
  if (MEMORY_TOKEN.test(body) || body.includes('TODO-Design') || MEMORY_BANNED.test(body)) {
    return { deliver: false, skipped: 'unrendered' };
  }
  return { deliver: true, body };
}

export async function sendMemoryKindReply(
  send: (body: string) => Promise<unknown>,
  body: string,
  env: MemoryKindEnv = process.env,
): Promise<{ sent: boolean; skipped: 'flag_off' | 'copy_not_locked' | 'unrendered' | null }> {
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
    const repeat = input.existing?.kind === 'one_off' && input.existing.source === 'inferred';
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
