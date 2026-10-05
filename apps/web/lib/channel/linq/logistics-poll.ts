import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { closeFacts, writeFact } from '~/lib/memory/facts';
import type { PollOptionWrite } from './poll';

/**
 * VIL-377 — logistics polls in a claimed Linq group.
 *
 * One flag: LINQ_POLLS, shared with the year-find poll. Year-find options and
 * the "only after two or more hits" rule stay in poll.ts.
 *
 * The question itself is the group-voice `who_takes` / `both_free` line
 * (group-voice.ts); the poll goes out under it with no prompt of its own. The
 * only fixed strings here are the two trailing OPTION LABELS. They are poll
 * buttons the reply parser matches back by exact text, not sentences Hale
 * says, so they stay code-supplied. "We'll figure it out" / "On verra" stores
 * no taker.
 */

/** Poll option label. Always the last who-takes option. Not a named taker. */
export const FIGURE_IT_OUT: Record<ReplyLanguage, string> = {
  en: "We'll figure it out",
  fr: 'On verra',
};

/** Poll option label. Always the last both-free option. Ends the ask. Not a chosen slot. */
export const BOTH_FREE_NONE: Record<ReplyLanguage, string> = {
  en: 'None of these',
  fr: 'Aucun de ceux-la',
};

const FIGURE_OPTIONS = new Set<string>([
  FIGURE_IT_OUT.en.toLowerCase(),
  FIGURE_IT_OUT.fr.toLowerCase(),
]);

const NONE_OPTIONS = new Set<string>([
  BOTH_FREE_NONE.en.toLowerCase(),
  BOTH_FREE_NONE.fr.toLowerCase(),
]);

const SPEAKER_TAKES =
  /^(?:i(?:'ll| will) take(?: it)?|i(?:'ve| have) got(?: it)?|je m(?:'en|en) occupe|c(?:'est|est) moi)\b/i;

const NAMED_TAKES = /^(?:will take|is taking|['’]s taking|takes|s'en occupe|s'occupe)\b/i;

export interface LogisticsParent {
  userId: string;
  name: string;
}

export interface LogisticsSlot {
  label: string;
  startIso: string;
}

export type LogisticsStatus = 'open' | 'decided' | 'declined';

export interface RememberedLogistics {
  factKey: string;
  kind: 'who_takes' | 'both_free';
  status: LogisticsStatus;
  startIso: string | null;
  titleNorm: string | null;
  takerUserId: string | null;
  slotLabel: string | null;
  slotStart: string | null;
  kid: string | null;
  event: string | null;
  day: string | null;
  slots: readonly LogisticsSlot[];
}

interface LogisticsFactValue {
  kind: 'who_takes' | 'both_free';
  status: LogisticsStatus;
  startIso: string | null;
  titleNorm: string | null;
  takerUserId: string | null;
  slotLabel: string | null;
  slotStart: string | null;
  kid: string | null;
  event: string | null;
  day: string | null;
  slots: LogisticsSlot[];
  source: 'poll' | 'text';
}

/** The pass option, either language. Not a parent name. */
export function isFigureItOutLine(text: string): boolean {
  return FIGURE_OPTIONS.has(text.trim().replace(/\s+/g, ' ').toLowerCase());
}

export function whoTakesFactKey(startIso: string, titleNorm: string): string {
  return `who-takes/${startIso}/${encodeURIComponent(titleNorm)}`;
}

function parseWhoTakesKey(factKey: string): { startIso: string; titleNorm: string } | null {
  const match = /^who-takes\/([^/]+)\/(.+)$/.exec(factKey);
  const startIso = match?.[1];
  const title = match?.[2];
  if (!startIso || !title) return null;
  try {
    return { startIso, titleNorm: decodeURIComponent(title) };
  } catch {
    return null;
  }
}

export function bothFreeFactKey(day: string): string {
  return `both-free/${day}`;
}

/** Local calendar day in the parent timezone. en-CA is YYYY-MM-DD. */
export function bothFreeDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Parent display names, then the trailing figure-it-out line. Fewer than two
 * distinct labels is no poll. A blank name is dropped. Two parents with the
 * same name cannot be told apart, so that is no poll either.
 */
export function whoTakesPollOptions(
  language: ReplyLanguage,
  parents: readonly LogisticsParent[],
  subjectKey: string,
): readonly PollOptionWrite[] | null {
  const trailing = FIGURE_IT_OUT[language];
  const seen = new Set<string>();
  const options: PollOptionWrite[] = [];
  let collided = false;
  for (const parent of parents) {
    const name = parent.name.trim();
    if (!name || FIGURE_OPTIONS.has(name.toLowerCase())) continue;
    if (seen.has(name.toLowerCase())) {
      collided = true;
      continue;
    }
    seen.add(name.toLowerCase());
    options.push({
      text: name,
      pollKind: 'who_takes',
      subjectKey,
      choiceKind: 'parent',
      choiceValue: parent.userId,
    });
  }
  if (collided || options.length === 0) return null;
  options.push({
    text: trailing,
    pollKind: 'who_takes',
    subjectKey,
    choiceKind: 'figure_it_out',
    choiceValue: null,
  });
  return options;
}

/**
 * Up to three slot labels, then the trailing none line. One slot is not a
 * poll. A label that is itself the none line is dropped.
 */
export function bothFreePollOptions(
  language: ReplyLanguage,
  slots: readonly LogisticsSlot[],
  subjectKey: string,
): readonly PollOptionWrite[] | null {
  const trailing = BOTH_FREE_NONE[language];
  const seen = new Set<string>();
  const options: PollOptionWrite[] = [];
  for (const slot of slots) {
    const label = slot.label.trim();
    if (!label || seen.has(label) || NONE_OPTIONS.has(label.toLowerCase())) continue;
    seen.add(label);
    options.push({
      text: label,
      pollKind: 'both_free',
      subjectKey,
      choiceKind: 'slot',
      choiceValue: slot.startIso,
    });
    if (options.length === 3) break;
  }
  if (options.length < 2) return null;
  options.push({
    text: trailing,
    pollKind: 'both_free',
    subjectKey,
    choiceKind: 'none',
    choiceValue: null,
  });
  return options;
}

export function isLogisticsPollKind(pollKind: string | null): boolean {
  return pollKind === 'who_takes' || pollKind === 'both_free';
}

/** A clear who-takes reply. A question is not one. The speaker claim does not guess a name. */
export function readWhoTakesReply(
  body: string,
  parents: readonly LogisticsParent[],
  speakerUserId: string,
): { takerUserId: string } | { declined: true } | null {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.includes('?')) return null;
  if (FIGURE_OPTIONS.has(trimmed.toLowerCase())) return { declined: true };
  if (SPEAKER_TAKES.test(trimmed)) return { takerUserId: speakerUserId };
  const named = [...parents]
    .filter((parent) => parent.name.trim().length > 0)
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  const lower = trimmed.toLowerCase();
  for (const parent of named) {
    const name = parent.name.trim();
    if (!lower.startsWith(name.toLowerCase())) continue;
    const after = trimmed.slice(name.length).trim();
    if (NAMED_TAKES.test(after)) return { takerUserId: parent.userId };
  }
  return null;
}

/** A clear slot reply against labels Hale already offered. */
export function readSlotReply(
  body: string,
  slots: readonly LogisticsSlot[],
): { slot: LogisticsSlot } | { declined: true } | null {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.includes('?')) return null;
  if (NONE_OPTIONS.has(trimmed.toLowerCase())) return { declined: true };
  const match = slots.find((slot) => slot.label.trim().toLowerCase() === trimmed.toLowerCase());
  if (!match) return null;
  return { slot: match };
}

function asFact(value: unknown, factKey: string): RememberedLogistics | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<LogisticsFactValue>;
  if (row.kind !== 'who_takes' && row.kind !== 'both_free') return null;
  if (row.status !== 'open' && row.status !== 'decided' && row.status !== 'declined') return null;
  const slots = Array.isArray(row.slots)
    ? row.slots.filter(
        (slot): slot is LogisticsSlot =>
          !!slot &&
          typeof slot === 'object' &&
          typeof (slot as LogisticsSlot).label === 'string' &&
          typeof (slot as LogisticsSlot).startIso === 'string',
      )
    : [];
  return {
    factKey,
    kind: row.kind,
    status: row.status,
    startIso: typeof row.startIso === 'string' ? row.startIso : null,
    titleNorm: typeof row.titleNorm === 'string' ? row.titleNorm : null,
    takerUserId: typeof row.takerUserId === 'string' ? row.takerUserId : null,
    slotLabel: typeof row.slotLabel === 'string' ? row.slotLabel : null,
    slotStart: typeof row.slotStart === 'string' ? row.slotStart : null,
    kid: typeof row.kid === 'string' ? row.kid : null,
    event: typeof row.event === 'string' ? row.event : null,
    day: typeof row.day === 'string' ? row.day : null,
    slots,
  };
}

export async function loadRememberedLogistics(
  database: Database,
  familyId: string,
): Promise<RememberedLogistics[]> {
  if (typeof database.select !== 'function') return [];
  const rows = await database
    .select({
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      factType: schema.familyMemoryFacts.factType,
      familyId: schema.familyMemoryFacts.familyId,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factType, 'logistic'),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
  const remembered: RememberedLogistics[] = [];
  for (const row of rows) {
    if (row.familyId !== familyId || row.factType !== 'logistic' || row.validUntil) continue;
    if (!row.factKey.startsWith('who-takes/') && !row.factKey.startsWith('both-free/')) continue;
    const parsed = asFact(row.factValue, row.factKey);
    if (parsed) remembered.push(parsed);
  }
  return remembered;
}

export function rememberedWhoTakes(
  remembered: readonly RememberedLogistics[],
  startIso: string,
  titleNorm: string,
): RememberedLogistics | null {
  return (
    remembered.find(
      (row) => row.kind === 'who_takes' && row.startIso === startIso && row.titleNorm === titleNorm,
    ) ?? null
  );
}

export async function writeLogisticsDecision(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    factKey: string;
    value: LogisticsFactValue;
    childId: string | null;
    now: Date;
  },
): Promise<void> {
  const write = {
    familyId: input.familyId,
    childId: input.childId,
    factType: 'logistic' as const,
    factKey: input.factKey,
    factValue: input.value,
    confidence: 1,
    inferredBy: input.value.source === 'poll' ? 'linq_logistics_poll' : 'linq_logistics_text',
    validFrom: input.now,
  };
  const audit = {
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'logistics_decision_recorded',
    targetTable: 'family_memory_facts' as const,
    targetId: input.familyId,
    after: { kind: input.value.kind, status: input.value.status, source: input.value.source },
  };
  if (typeof database.transaction === 'function') {
    await database.transaction(async (tx) => {
      await tx.insert(schema.auditLog).values(audit);
      await writeFact(tx, write);
    });
    return;
  }
  await database.insert(schema.auditLog).values(audit);
  await writeFact(database, write);
}

export async function recordLogisticsVote(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    subjectKey: string;
    pollKind: 'who_takes' | 'both_free';
    choiceKind: string | null;
    choiceValue: string | null;
    optionText: string;
    now: Date;
  },
): Promise<'decided' | 'declined' | 'passed' | 'ignored'> {
  if (!input.subjectKey) return 'ignored';
  if (input.choiceKind === 'figure_it_out') {
    await withholdWhoTakes(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      factKey: input.subjectKey,
      now: input.now,
      source: 'poll',
    });
    return 'passed';
  }
  const existing = (await loadRememberedLogistics(database, input.familyId)).find(
    (row) => row.factKey === input.subjectKey,
  );
  const parsed = parseWhoTakesKey(input.subjectKey);
  if (input.choiceKind === 'parent' && !input.choiceValue) return 'ignored';
  if (input.choiceKind === 'slot' && !input.choiceValue) return 'ignored';
  const declined = input.choiceKind === 'none';
  const status: LogisticsStatus = declined ? 'declined' : 'decided';
  await writeLogisticsDecision(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    factKey: input.subjectKey,
    childId: null,
    now: input.now,
    value: {
      kind: input.pollKind,
      status,
      startIso: existing?.startIso ?? parsed?.startIso ?? null,
      titleNorm: existing?.titleNorm ?? parsed?.titleNorm ?? null,
      takerUserId: status === 'decided' && input.choiceKind === 'parent' ? input.choiceValue : null,
      slotLabel: status === 'decided' && input.choiceKind === 'slot' ? input.optionText : null,
      slotStart: status === 'decided' && input.choiceKind === 'slot' ? input.choiceValue : null,
      kid: existing?.kid ?? null,
      event: existing?.event ?? null,
      day: existing?.day ?? null,
      slots: [...(existing?.slots ?? [])],
      source: 'poll',
    },
  });
  return status === 'decided' ? 'decided' : 'declined';
}

/**
 * "We'll figure it out" stores no taker. A live open ask for this event is
 * closed, and nothing is written in its place. The evening handoff does not
 * read a name from this. Same-day silence is the caller's dedupe and the
 * statement check, not a stored decision.
 */
export async function withholdWhoTakes(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    factKey: string;
    now: Date;
    source: 'poll' | 'text';
  },
): Promise<void> {
  const audit = {
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'logistics_decision_withheld',
    targetTable: 'family_memory_facts' as const,
    targetId: input.familyId,
    after: { kind: 'who_takes' as const, stored: false, source: input.source },
  };
  const run = async (
    writer: Parameters<typeof closeFacts>[0] & Pick<Database, 'insert' | 'select'>,
  ) => {
    await writer.insert(schema.auditLog).values(audit);
    const live = await writer
      .select({ id: schema.familyMemoryFacts.id })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, input.familyId),
          eq(schema.familyMemoryFacts.factType, 'logistic'),
          eq(schema.familyMemoryFacts.factKey, input.factKey),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    await closeFacts(writer, {
      factIds: live.map((row) => row.id),
      closedAt: input.now,
      supersededBy: null,
    });
  };
  if (typeof database.transaction === 'function') {
    await database.transaction(async (tx) => {
      await run(tx);
    });
    return;
  }
  await run(database);
}
