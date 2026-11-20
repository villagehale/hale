import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import {
  type FactSource,
  type FactSourceLabel,
  loadFactSources,
  readerTimeZone,
} from '@hale/worker/fact-sources';
import { type FactReader, audiencePredicate, newestPerIdentity } from '@hale/worker/memory-context';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type ReplyLanguage, acceptReplyLanguage } from '~/lib/channel/language';
import { linqGroupCoparentEnabled } from '~/lib/channel/linq/config';
import { type MeaningScreen, sharedMeaningScreen } from '~/lib/channel/meaning-screen/read';
import { replyProse } from '~/lib/channel/reply-copy/apply';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { promptKind, readDisposition } from './classify-write';
import { type FactHeard, closeFacts, writeFact } from './facts';
import { forgetFamilyFact } from './forget';
import { renderMemoryGroupSync } from './group-sync';
import {
  type MemoryKindEnv,
  type MemorySource,
  type PromotionSignal,
  applyPromotionSignal,
  classifyMemoryWrite,
  deliverMemoryKindCopy,
  familyMemoryKindsEnabled,
  includeInRecommendations,
  isLastingFactKey,
  memoryTextOverlaps,
  toFamilyMemoryExportFact,
} from './kinds';
import { isReceiptKey } from './lexicon';
import { type RecordField, recordFieldOf, withRecordField } from './record-field';
import { type MemoryRequest, readMemoryRequest, readMemoryTargets } from './request';
import { SYNTHESIS_WRITERS } from './synthesis';

/** The skill that writes every family-memory reply (rule #2: loaded by name). */
export const MEMORY_REPLY_SKILL = 'memory-reply';

const BELIEF_WRITERS = new Set<string>(SYNTHESIS_WRITERS);
const RECOMMENDATION_LIMIT = 40;
/** The newest beliefs a "what do you know" list is written from. */
const RECALL_LIMIT = 40;
type MemoryFactType = schema.NewFamilyMemoryFact['factType'];

export interface MemoryTypingFields {
  memoryKind?: 'lasting' | 'temporary' | 'one_off';
  memorySource?: MemorySource;
  sourcedAt?: Date;
  expiresAt?: Date | null;
  signalCount?: number;
}

/**
 * Flag off: no read, no fields. The insert keeps the column defaults
 * (`lasting` / `legacy`), which is the pre-flag behavior.
 */
export async function memoryTypingForWrite(
  database: Database,
  input: {
    familyId: string;
    childId: string | null;
    factType: string;
    factKey: string;
    source: MemorySource;
    now: Date;
    expiresAt?: Date | null;
    env?: MemoryKindEnv;
  },
): Promise<MemoryTypingFields> {
  const env = input.env ?? process.env;
  if (!familyMemoryKindsEnabled(env)) return {};

  const [existing] = await database
    .select({
      kind: schema.familyMemoryFacts.memoryKind,
      source: schema.familyMemoryFacts.memorySource,
      signalCount: schema.familyMemoryFacts.signalCount,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        input.childId === null
          ? isNull(schema.familyMemoryFacts.childId)
          : eq(schema.familyMemoryFacts.childId, input.childId),
        eq(schema.familyMemoryFacts.factType, input.factType as MemoryFactType),
        eq(schema.familyMemoryFacts.factKey, input.factKey),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .limit(1);

  const classified = classifyMemoryWrite({
    factType: input.factType,
    factKey: input.factKey,
    source: input.source,
    expiresAt: input.expiresAt ?? null,
    existing: existing
      ? {
          kind: existing.kind as 'lasting' | 'temporary' | 'one_off',
          source: existing.source as MemorySource,
          signalCount: existing.signalCount,
        }
      : null,
    signal:
      existing?.kind === 'one_off' && existing.source === 'inferred' && input.source === 'inferred'
        ? 'repeat_ask'
        : null,
  });

  return {
    memoryKind: classified.kind,
    memorySource: classified.source,
    sourcedAt: input.now,
    expiresAt: classified.expiresAt,
    signalCount: classified.signalCount,
  };
}

export interface RecommendationMemoryFact {
  childId: string | null;
  factType: string;
  factKey: string;
  factValue: unknown;
  confidence: number;
  /** Model vocabulary, so a ranker can weigh the fact. */
  kind: 'enduring' | 'obligation' | 'curiosity';
  disposition: 'confirmed' | 'declined' | 'asked';
  source: string;
}

/**
 * The memory signal rank-recommendations reads. Flag off returns every live
 * row (the previous query). Flag on drops `one_off` and expired `temporary`.
 * Expiry is a read-time filter: no sweep, so a clock skew cannot delete a row.
 */
export async function loadRecommendationMemory(
  database: Database,
  familyId: string,
  now: Date,
  env: MemoryKindEnv = process.env,
): Promise<RecommendationMemoryFact[]> {
  const enabled = familyMemoryKindsEnabled(env);
  const rows = await database
    .select({
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      confidence: schema.familyMemoryFacts.confidence,
      memoryKind: schema.familyMemoryFacts.memoryKind,
      memorySource: schema.familyMemoryFacts.memorySource,
      expiresAt: schema.familyMemoryFacts.expiresAt,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .limit(RECOMMENDATION_LIMIT);

  return rows
    .filter((row) => {
      // A decline and a passing question never steer a recommendation, flag or
      // not. The kinds flag still decides whether an unlabeled one-off does.
      const disposition = readDisposition(row.factValue);
      if (disposition === 'declined' || disposition === 'asked') return false;
      return includeInRecommendations(row, now, enabled);
    })
    .map((row) => ({
      childId: row.childId,
      factType: row.factType,
      factKey: row.factKey,
      factValue: row.factValue,
      confidence: row.confidence,
      kind: promptKind(row.memoryKind, row.factValue),
      disposition: readDisposition(row.factValue),
      source: row.memorySource,
    }));
}

export async function promoteMatchingInferredFacts(
  database: Database,
  input: {
    familyId: string;
    signal: PromotionSignal;
    needle: string;
    now: Date;
    env?: MemoryKindEnv;
  },
): Promise<{ promoted: number; skipped: 'flag_off' | null }> {
  if (!familyMemoryKindsEnabled(input.env ?? process.env)) {
    return { promoted: 0, skipped: 'flag_off' };
  }
  const needle = input.needle.trim();
  if (needle.length < 4) return { promoted: 0, skipped: null };

  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      memoryKind: schema.familyMemoryFacts.memoryKind,
      memorySource: schema.familyMemoryFacts.memorySource,
      signalCount: schema.familyMemoryFacts.signalCount,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        eq(schema.familyMemoryFacts.memoryKind, 'one_off'),
        eq(schema.familyMemoryFacts.memorySource, 'inferred'),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .limit(50);

  const matches = rows.filter((row) => {
    const decision = applyPromotionSignal(
      {
        kind: 'one_off',
        source: 'inferred',
        signalCount: row.signalCount,
      },
      input.signal,
    );
    return decision.promoted && memoryTextOverlaps(row.factKey, row.factValue, needle);
  });
  if (matches.length === 0) return { promoted: 0, skipped: null };

  await database
    .update(schema.familyMemoryFacts)
    .set({
      memoryKind: 'lasting',
      signalCount: sql`${schema.familyMemoryFacts.signalCount} + 1`,
    })
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        eq(schema.familyMemoryFacts.memoryKind, 'one_off'),
        eq(schema.familyMemoryFacts.memorySource, 'inferred'),
        isNull(schema.familyMemoryFacts.validUntil),
        inArray(
          schema.familyMemoryFacts.id,
          matches.map((row) => row.id),
        ),
      ),
    );

  return { promoted: matches.length, skipped: null };
}

export interface RecallFact {
  id: string;
  factType: string;
  factKey: string;
  factValue: unknown;
  kind: string;
  source: string;
  sourcedAt: string;
  expiresAt: string | null;
  sourceEventId: string | null;
}

async function teenIds(database: Database, familyId: string, now: Date): Promise<Set<string>> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return new Set(
    children.filter((child) => deriveStage(child.dateOfBirth, now) === 'teenager').map((c) => c.id),
  );
}

function beliefRow(row: { factKey: string; inferredBy: string | null }): boolean {
  if (isReceiptKey(row.factKey)) return false;
  if (row.inferredBy === null || !BELIEF_WRITERS.has(row.inferredBy)) return false;
  return true;
}

/**
 * What a parent may be told Hale holds. Lasting, unexpired temporary, and
 * one-off beliefs. Expired temporary rows are already gone at read time.
 * Teen-attributed rows and control-plane receipts stay out, and so does what another
 * adult said in their own 1:1 (VIL-599, the rule every prompt read uses).
 */
export async function recallFamilyMemory(
  database: Database,
  input: { familyId: string; now: Date; reader: FactReader },
): Promise<RecallFact[]> {
  const [teens, audience] = await Promise.all([
    teenIds(database, input.familyId, input.now),
    audiencePredicate(database, input.familyId, input.reader),
  ]);
  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      inferredBy: schema.familyMemoryFacts.inferredBy,
      memoryKind: schema.familyMemoryFacts.memoryKind,
      memorySource: schema.familyMemoryFacts.memorySource,
      sourcedAt: schema.familyMemoryFacts.sourcedAt,
      expiresAt: schema.familyMemoryFacts.expiresAt,
      validUntil: schema.familyMemoryFacts.validUntil,
      sourceEventId: schema.familyMemoryFacts.sourceEventId,
      validFrom: schema.familyMemoryFacts.validFrom,
      createdAt: schema.familyMemoryFacts.createdAt,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        isNull(schema.familyMemoryFacts.validUntil),
        // Beliefs only, before the limit: a family's duty and logistics rows must not
        // crowd the newest beliefs out of what a parent is told Hale remembers.
        inArray(schema.familyMemoryFacts.inferredBy, [...SYNTHESIS_WRITERS]),
        audience,
      ),
    )
    .orderBy(desc(schema.familyMemoryFacts.sourcedAt))
    .limit(RECALL_LIMIT);

  return newestPerIdentity(rows)
    .filter((row) => !row.childId || !teens.has(row.childId))
    .filter((row) => beliefRow(row))
    .filter((row) => includeInRecommendations(row, input.now, true) || row.memoryKind === 'one_off')
    .map((row) => {
      const exported = toFamilyMemoryExportFact(row);
      return {
        id: exported.id,
        factType: exported.factType,
        factKey: exported.factKey,
        factValue: row.factValue,
        kind: exported.kind,
        source: exported.source,
        sourcedAt: exported.sourcedAt,
        expiresAt: exported.expiresAt,
        sourceEventId: row.sourceEventId,
      };
    });
}

export interface ParentMemoryResult {
  claimed: boolean;
  outcome: string;
  /** Null unless the model wrote it and the copy gate passed. Nothing else is ever sent. */
  reply: string | null;
  /** A group turn: the reply is for the asker alone, never the group (router `onlyToAsker`). */
  onlyToAsker: boolean;
  forgotten: number;
  corrected: number;
  groupSync: { synced: boolean; skipped: string };
}

async function familyDoor(
  database: Database,
  familyId: string,
): Promise<{ groupChatId: string | null; language: ReplyLanguage | null }> {
  const [family] = await database
    .select({
      linqGroupChatId: schema.families.linqGroupChatId,
      primaryLanguage: schema.families.primaryLanguage,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  return {
    groupChatId: family?.linqGroupChatId ?? null,
    language: acceptReplyLanguage(family?.primaryLanguage),
  };
}

/**
 * The chat a turn arrived in, and whether the door recorded it as one-to-one. Only an
 * explicit `in_group = false` is one-to-one: no message, no row or an unrecorded bit is
 * read as a group, so a turn the door could not place never hears a source.
 */
async function inboundOrigin(
  database: Database,
  messageId: string | null,
): Promise<{ chatId: string | null; oneToOne: boolean; inGroup: boolean }> {
  if (!messageId) return { chatId: null, oneToOne: false, inGroup: false };
  const [row] = await database
    .select({
      providerChatId: schema.channelMessages.providerChatId,
      inGroup: schema.channelMessages.inGroup,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, messageId))
    .limit(1);
  return {
    chatId: row?.providerChatId ?? null,
    oneToOne: row?.inGroup === false,
    inGroup: row?.inGroup === true,
  };
}

export async function syncMemoryDecisionToGroup(
  database: Database,
  input: {
    familyId: string;
    originChatId: string | null;
    language: ReplyLanguage | null;
    actorUserId: string;
    change: 'forget' | 'correct';
    env?: MemoryKindEnv;
    sendGroup?: (chatId: string, body: string) => Promise<unknown>;
  },
): Promise<{ synced: boolean; skipped: string }> {
  const env = input.env ?? process.env;
  if (!linqGroupCoparentEnabled()) return { synced: false, skipped: 'group_disabled' };
  const door = await familyDoor(database, input.familyId);
  const groupChatId = door.groupChatId;
  if (!groupChatId) return { synced: false, skipped: 'no_group' };
  if (input.originChatId && input.originChatId === groupChatId) {
    return { synced: false, skipped: 'already_home' };
  }
  const who = await parentSpokenName(database, input.actorUserId);
  if (!who) return { synced: false, skipped: 'unnamed' };
  const body = await renderMemoryGroupSync(input.language, input.change, who);
  if (!body) return { synced: false, skipped: 'model_unreachable' };
  const gated = deliverMemoryKindCopy(body, env);
  if (!gated.deliver) return { synced: false, skipped: gated.skipped };
  if (!input.sendGroup) return { synced: false, skipped: 'sender_absent' };
  const sent = await input.sendGroup(groupChatId, gated.body);
  if (sent !== 'sent') {
    return { synced: false, skipped: typeof sent === 'string' ? sent : 'not_sent' };
  }
  return { synced: true, skipped: 'sent' };
}

function gatedReply(body: string, env: MemoryKindEnv): string | null {
  const gated = deliverMemoryKindCopy(body, env);
  return gated.deliver ? gated.body : null;
}

function displayFactValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['value', 'note', 'summary', 'text', 'name']) {
    const found = record[key];
    if (typeof found === 'string' && found.trim()) return found.trim();
  }
  return null;
}

/** The reader's day, in the language the reply is written in, so the model can copy it. */
function readerDay(on: Date, language: ReplyLanguage, timeZone: string): string {
  const options = { month: 'short', day: 'numeric', timeZone } as const;
  try {
    return new Intl.DateTimeFormat(language, options).format(on);
  } catch {
    return new Intl.DateTimeFormat('en', options).format(on);
  }
}

/** Where a connector fact was seen, as data for the model: who or what, and the reader's day. */
function seenWords(label: FactSourceLabel, language: ReplyLanguage, timeZone: string): string {
  const on = readerDay(label.on, language, timeZone);
  return label.kind === 'email'
    ? `an email from ${label.from}, ${on}`
    : `${label.title} on their calendar, ${on}`;
}

/** Provenance as data for the model. The model words it in the parent's language. */
const SOURCE_WORDS: Record<string, string> = {
  parent_message: 'the parent told Hale',
  calendar: 'their calendar',
  inferred: "Hale's own guess",
  legacy: 'saved earlier, source not noted',
};

const KIND_WORDS: Record<string, string> = {
  lasting: 'kept until they change it',
  temporary: 'for now',
  one_off: 'seen once',
};

/** One remembered fact as the memory reads and the reply see it. Never parent copy. */
interface MemoryLine {
  factId: string;
  factKey: string;
  value: string;
  /** A belief Hale may drop at a parent's word (forget.ts). */
  forgettable: boolean;
  /**
   * A belief, or a row saved before writers were kept, that a parent's correction may
   * replace. Never a receipt and never another writer's record (a duty, a logistics
   * decision, weekday care): those have their own paths and a text must not overwrite them.
   */
  correctable: boolean;
  /** `key: value (source; seen; how long)`, the data line handed to the model. */
  line: string;
}

/**
 * The facts a parent may be told about, each with where it came from. A fact Hale took
 * from Gmail or Calendar carries where it was seen, or is left out: a connector fact whose
 * source this reader may not hear is not listed (VIL-429).
 */
function memoryLines(
  facts: readonly RecallFact[],
  sources: ReadonlyMap<string, FactSource>,
  language: ReplyLanguage,
  timeZone: string,
): MemoryLine[] {
  const lines: MemoryLine[] = [];
  for (const fact of facts) {
    if (fact.source === 'receipt') continue;
    const value = displayFactValue(fact.factValue);
    if (!value) continue;
    const found = fact.sourceEventId ? sources.get(fact.sourceEventId) : undefined;
    if (found?.connector && !found.label) continue;
    const parts = [`source: ${SOURCE_WORDS[fact.source] ?? SOURCE_WORDS.legacy}`];
    if (found?.connector && found.label) {
      parts.push(`seen: ${seenWords(found.label, language, timeZone)}`);
    }
    parts.push(KIND_WORDS[fact.kind] ?? KIND_WORDS.lasting ?? '');
    lines.push({
      factId: fact.id,
      factKey: fact.factKey,
      value: value.replace(/\s+/g, ' '),
      forgettable: true,
      correctable: true,
      line: `${fact.factKey}: ${value.replace(/\s+/g, ' ')} (${parts.join('; ')})`,
    });
  }
  return lines;
}

async function parentSpokenName(database: Database, userId: string): Promise<string | null> {
  const [row] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const trimmed = row?.name?.trim() ?? '';
  if (!trimmed || (trimmed.match(/\d/g) ?? []).length >= 7) return null;
  const first = trimmed.split(/\s+/)[0] ?? '';
  if (!/^[A-Za-z][A-Za-z'.-]*$/.test(first)) return null;
  return first;
}

/** A memory reply's purpose, read by the `memory-reply` skill. There is no sentence behind it. */
type MemoryPurpose =
  | 'memory_list'
  | 'memory_list_empty'
  | 'memory_list_private'
  | 'memory_forgotten'
  | 'memory_forget_unmatched'
  | 'memory_forget_kept'
  | 'memory_corrected'
  | 'memory_correct_unmatched'
  | 'memory_correct_kept';

/** A family-memory list can be long; every other memory reply is a line or two. */
const MEMORY_LIST_MAX_TOKENS = 1600;

/**
 * Where this turn arrived. Only an explicit `in_group = false` row is one-to-one; an
 * explicit `true` is a group. The router refuses an iMessage turn it cannot place before
 * any handler runs, so `unplaced` is a spoken or legacy turn with no row.
 */
type MemoryPlacement = 'one_to_one' | 'group' | 'unplaced';

/**
 * A parent asked what Hale knows, or asked it to forget or correct a fact.
 *
 * Flag off is a no-op before any read. The request is the model's meaning read
 * (`memory_request`); which fact a forget or a correction means is a second read over
 * only the facts this parent may hear (`memory_target`). Every word of the reply is
 * written by the model (`memory-reply`) from what happened; a miss holds it.
 *
 * On a group turn every reply is for the asker alone (`onlyToAsker`): the router sends it
 * to their own phone or not at all, so the group never hears the list or a value. A 1:1
 * forget or correction is mirrored to the claimed group as who-and-what-kind only, and
 * nowhere else — this function never opens a 1:1.
 */
export async function handleParentMemory(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    now: Date;
    inboundChannelMessageId: string | null;
    env?: MemoryKindEnv;
    sendGroup?: (chatId: string, body: string) => Promise<unknown>;
    /** Injected model. Absent: nothing is sent, and the model is not called. */
    replyClient?: AgentClient | null;
    /** The meaning screen for the request and its target. Absent: the shared screen. */
    screen?: MeaningScreen;
    /** The request, when the caller already read it. Absent: read here. */
    request?: MemoryRequest;
  },
): Promise<ParentMemoryResult> {
  const env = input.env ?? process.env;
  const idle: ParentMemoryResult = {
    claimed: false,
    outcome: 'flag_off',
    reply: null,
    onlyToAsker: false,
    forgotten: 0,
    corrected: 0,
    groupSync: { synced: false, skipped: 'not_run' },
  };
  if (!familyMemoryKindsEnabled(env)) return idle;

  const screen = input.screen ?? sharedMeaningScreen();
  const read = input.request ?? (await readMemoryRequest(screen, input.body));
  if (read === 'unread') return { ...idle, outcome: 'unread' };
  if (!read) return { ...idle, outcome: 'not_memory' };
  const request = read;

  const door = await familyDoor(database, input.familyId);
  const inbound = await inboundOrigin(database, input.inboundChannelMessageId);
  const origin = inbound.chatId;
  const placement: MemoryPlacement = inbound.oneToOne
    ? 'one_to_one'
    : inbound.inGroup
      ? 'group'
      : 'unplaced';
  // The language the parent wrote in decides the reply; the family's stored one only
  // when the screen read none.
  const language = request.language ?? door.language ?? 'en';
  // A group turn's reply goes to the asker alone, so it is written for them. A turn
  // nobody can place hears only what every adult may hear, and no value is said.
  const audience: 'direct' | 'group' = placement === 'unplaced' ? 'group' : 'direct';
  const onlyToAsker = placement === 'group';
  const reader: FactReader =
    placement === 'unplaced' ? 'every_adult' : { adult: input.parentUserId };

  const layer = {
    client: await resolveReplyClient(input.replyClient),
    database,
    familyId: input.familyId,
    language,
    audience,
    surface: 'memory' as const,
    skillName: MEMORY_REPLY_SKILL,
  };
  const write = async (
    purpose: MemoryPurpose,
    facts: readonly string[],
    options: { questionAllowed?: boolean; sealedValues?: readonly string[] } = {},
  ): Promise<string | null> => {
    try {
      const body = await replyProse(layer, {
        purpose,
        facts,
        questionAllowed: options.questionAllowed ?? false,
        sealedValues: audience === 'group' ? options.sealedValues : undefined,
        ...(purpose === 'memory_list' ? { maxTokens: MEMORY_LIST_MAX_TOKENS } : {}),
      });
      return body ? gatedReply(body, env) : null;
    } catch (err) {
      console.error(
        { purpose, err: err instanceof Error ? err.name : 'unknown' },
        'family memory: reply not written',
      );
      return null;
    }
  };
  const claimed = (
    outcome: string,
    reply: string | null,
    rest: Partial<Pick<ParentMemoryResult, 'forgotten' | 'corrected' | 'groupSync'>> = {},
  ): ParentMemoryResult => {
    if (reply === null) {
      console.warn({ outcome, placement }, 'family memory: claimed, nothing to send');
    }
    return {
      claimed: true,
      outcome,
      reply,
      onlyToAsker,
      forgotten: rest.forgotten ?? 0,
      corrected: rest.corrected ?? 0,
      groupSync: rest.groupSync ?? { synced: false, skipped: 'not_a_decision' },
    };
  };

  // Where nobody can tell who is reading, the list is not said at all, and not read.
  if (request.kind === 'list' && placement === 'unplaced') {
    return claimed('recall_withheld', await write('memory_list_private', []));
  }

  const lines = await readableMemory(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    reader,
    placement,
    now: input.now,
    language,
  });

  if (request.kind === 'list') {
    const listed = lines.filter((line) => line.forgettable);
    const reply =
      listed.length === 0
        ? await write('memory_list_empty', [])
        : await write(
            'memory_list',
            listed.map((line) => line.line),
            { sealedValues: listed.map((line) => line.value) },
          );
    return claimed('recalled', reply);
  }

  // Which fact the parent means is the model's read over the facts they may hear, by ref.
  // An unread target acts on nothing: the turn is claimed and held.
  const targets = await readMemoryTargets(screen, input.body, lines);
  if (targets === 'unread') return claimed('target_unread', null);

  if (request.kind === 'forget') {
    const forgotten: MemoryLine[] = [];
    const kept: MemoryLine[] = [];
    for (const line of targets.chosen) {
      if (!line.forgettable) {
        kept.push(line);
        continue;
      }
      const result = await forgetFamilyFact(database, {
        familyId: input.familyId,
        factId: line.factId,
        actor: input.parentUserId,
        now: input.now,
      });
      if (result.forgotten > 0) forgotten.push(line);
      else if (result.refusedControlPlane > 0 || result.refusedWriter > 0) kept.push(line);
    }
    const groupSync =
      forgotten.length > 0
        ? await syncMemoryDecisionToGroup(database, {
            familyId: input.familyId,
            originChatId: origin,
            language: door.language,
            actorUserId: input.parentUserId,
            change: 'forget',
            env,
            sendGroup: input.sendGroup,
          })
        : { synced: false, skipped: 'nothing_to_sync' };
    const sealed = [...forgotten, ...kept].map((line) => line.value);
    if (forgotten.length > 0) {
      const reply = await write(
        'memory_forgotten',
        [
          ...forgotten.map((line) => `forgotten: ${line.factKey}: ${line.value}`),
          ...kept.map((line) => `kept as a record: ${line.factKey}: ${line.value}`),
        ],
        { sealedValues: sealed },
      );
      return claimed('forgotten', reply, { forgotten: forgotten.length, groupSync });
    }
    if (kept.length > 0) {
      const reply = await write(
        'memory_forget_kept',
        kept.map((line) => `kept as a record: ${line.factKey}: ${line.value}`),
        { sealedValues: sealed },
      );
      return claimed('refused', reply, { groupSync });
    }
    const reply = await write(
      'memory_forget_unmatched',
      request.target ? [`they asked to forget: ${request.target}`] : [],
      { questionAllowed: true, sealedValues: request.target ? [request.target] : [] },
    );
    return claimed('nothing', reply, { groupSync });
  }

  // A correction: the one fact the new value replaces, or a key for a fact nothing the
  // parent may hear holds. Either way it is written as the sender's word, in their scope.
  const chosen = targets.chosen[0] ?? null;
  const value = (targets.value || request.value).trim();
  const factKey = chosen ? chosen.factKey : targets.key;
  if (!factKey || !value) {
    const reply = await write(
      'memory_correct_unmatched',
      request.target ? [`they asked to change: ${request.target}`] : [],
      { questionAllowed: true, sealedValues: request.target ? [request.target] : [] },
    );
    return claimed('nothing', reply);
  }
  if ((chosen && !chosen.correctable) || isReceiptKey(factKey)) {
    const reply = await write(
      'memory_correct_kept',
      [`kept as a record: ${factKey}${chosen ? `: ${chosen.value}` : ''}`],
      { sealedValues: [value, ...(chosen ? [chosen.value] : [])] },
    );
    return claimed('refused', reply);
  }
  const corrected = await correctFamilyFact(database, {
    familyId: input.familyId,
    actor: input.parentUserId,
    reader,
    // A correction is the speaker's own unless the door recorded the family group: a turn
    // it could not place stays with the adult who sent it (decision R7).
    heard: inbound.inGroup
      ? { in: 'family', userId: input.parentUserId }
      : { in: 'one_to_one', userId: input.parentUserId },
    factKey,
    value,
    now: input.now,
  });
  if (!corrected.corrected) {
    const reply = await write('memory_correct_kept', [`kept as a record: ${factKey}`], {
      sealedValues: [value],
    });
    return claimed('refused', reply);
  }
  const groupSync = await syncMemoryDecisionToGroup(database, {
    familyId: input.familyId,
    originChatId: origin,
    language: door.language,
    actorUserId: input.parentUserId,
    change: 'correct',
    env,
    sendGroup: input.sendGroup,
  });
  const reply = await write(
    'memory_corrected',
    [`corrected: ${factKey}: ${value}`, ...(chosen ? [`was: ${chosen.value}`] : [])],
    { sealedValues: [value, ...(chosen ? [chosen.value] : [])] },
  );
  return claimed('corrected', reply, { corrected: 1, groupSync });
}

/**
 * What this parent may be told Hale remembers, newest first, as data lines: the beliefs
 * the list shows, and (for a forget or a correction to point at) the records Hale keeps,
 * marked kept. Teen-attributed rows, a source this reader may not hear, and what another
 * adult said in their own 1:1 stay out (VIL-599).
 */
async function readableMemory(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    reader: FactReader;
    placement: MemoryPlacement;
    now: Date;
    language: ReplyLanguage;
  },
): Promise<MemoryLine[]> {
  const facts = await recallFamilyMemory(database, {
    familyId: input.familyId,
    now: input.now,
    reader: input.reader,
  });
  const [sources, timeZone, records] = await Promise.all([
    loadFactSources(database, {
      familyId: input.familyId,
      readerUserId: input.parentUserId,
      inGroup: input.placement === 'unplaced',
      now: input.now,
      sourceEventIds: facts.map((fact) => fact.sourceEventId),
    }),
    readerTimeZone(database, input.parentUserId),
    keptRecords(database, input),
  ]);
  const listed = memoryLines(facts, sources, input.language, timeZone);
  const seen = new Set(listed.map((line) => line.factId));
  return [...listed, ...records.filter((record) => !seen.has(record.factId))];
}

/**
 * The live rows this reader may hear that a parent's text may not drop: control-plane
 * receipts, rows another writer owns, and rows saved before writers were kept. Shown to
 * the target read only, so "forget that we registered" is answered as a record Hale keeps
 * rather than as nothing found, and a correction can still replace an old unattributed
 * guess.
 */
async function keptRecords(
  database: Database,
  input: { familyId: string; reader: FactReader; now: Date },
): Promise<MemoryLine[]> {
  const [teens, audience] = await Promise.all([
    teenIds(database, input.familyId, input.now),
    audiencePredicate(database, input.familyId, input.reader),
  ]);
  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      inferredBy: schema.familyMemoryFacts.inferredBy,
      validFrom: schema.familyMemoryFacts.validFrom,
      createdAt: schema.familyMemoryFacts.createdAt,
      sourcedAt: schema.familyMemoryFacts.sourcedAt,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        isNull(schema.familyMemoryFacts.validUntil),
        audience,
      ),
    )
    .orderBy(desc(schema.familyMemoryFacts.sourcedAt))
    .limit(40);
  const kept: MemoryLine[] = [];
  for (const row of newestPerIdentity(rows)) {
    if (row.childId && teens.has(row.childId)) continue;
    if (beliefRow(row)) continue;
    const value = displayFactValue(row.factValue);
    if (!value) continue;
    // A row saved with no writer predates writers being kept: a correction may replace it.
    const correctable = row.inferredBy === null && !isReceiptKey(row.factKey);
    kept.push({
      factId: row.id,
      factKey: row.factKey,
      value: value.replace(/\s+/g, ' '),
      forgettable: false,
      correctable,
      line: `${row.factKey}: ${value.replace(/\s+/g, ' ')} (${
        correctable ? 'saved earlier, source not noted' : 'a record Hale keeps'
      })`,
    });
  }
  return kept;
}

async function correctFamilyFact(
  database: Database,
  input: {
    familyId: string;
    actor: string;
    reader: FactReader;
    heard: FactHeard;
    factKey: string;
    value: string;
    now: Date;
  },
): Promise<{ corrected: boolean }> {
  if (isReceiptKey(input.factKey) || !input.factKey || !input.value) return { corrected: false };
  const [teens, audience] = await Promise.all([
    teenIds(database, input.familyId, input.now),
    audiencePredicate(database, input.familyId, input.reader),
  ]);
  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      inferredBy: schema.familyMemoryFacts.inferredBy,
      sourceAudience: schema.familyMemoryFacts.sourceAudience,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        eq(schema.familyMemoryFacts.factKey, input.factKey),
        isNull(schema.familyMemoryFacts.validUntil),
        audience,
      ),
    );

  // Only what the sender may hear decides anything here. A key nobody holds and a key
  // only another adult's private fact holds read the same: the sender's word is written
  // as their own fact, in their own scope, and the other adult's row is not touched
  // (VIL-599). So the outcome can never say whether a fact the sender cannot hear exists.
  const live = rows.filter((row) => !row.childId || !teens.has(row.childId));
  // Another writer's record on this key (a duty, a logistics decision, weekday care) is not
  // a parent's text to overwrite: the write below would supersede it in its own identity.
  if (live.some((row) => row.inferredBy !== null && !BELIEF_WRITERS.has(row.inferredBy))) {
    return { corrected: false };
  }
  // The correction is written in the sender's scope and, like every write, supersedes only
  // within it. A household row it corrects from a 1:1 stays live for the other adult; the
  // sender's 1:1 reads the newer row, so they hear their correction (R7). Retiring the
  // household's row here would leave the other adult with no value at all.
  // The one exception is an `unrecorded` row (the nightly writer's guess, or a row saved
  // before speakers were kept), retired as a forget would retire it. The sender can see
  // one only while no other adult is on record, so this never takes a value from anyone.
  // A correction of the child's age or the family's home keeps that mark: said now, after
  // the record was written, it is what every prompt reads in the record's place
  // (recordCorrections). Without the mark it would be one more memory beside the old record.
  const subjects = new Map<
    string,
    {
      childId: string | null;
      factType: 'preference' | 'routine' | 'medical' | 'logistic' | 'relationship' | 'voice';
      unrecorded: string[];
      record: RecordField | null;
    }
  >();
  for (const row of live) {
    const key = `${row.childId ?? ''}|${row.factType}`;
    const subject = subjects.get(key) ?? {
      childId: row.childId,
      factType: row.factType,
      unrecorded: [],
      record: recordFieldOf(row.factValue),
    };
    if (row.sourceAudience === 'unrecorded') subject.unrecorded.push(row.id);
    if (subject.record === null) subject.record = recordFieldOf(row.factValue);
    subjects.set(key, subject);
  }
  if (subjects.size === 0) {
    subjects.set('', {
      childId: null,
      factType: factTypeFor(input.factKey),
      unrecorded: [],
      record: null,
    });
  }

  await database.transaction(async (tx) => {
    let superseded = 0;
    let factId = input.familyId;
    for (const subject of subjects.values()) {
      const written = await writeFact(tx, {
        familyId: input.familyId,
        childId: subject.childId,
        factType: subject.factType,
        factKey: input.factKey,
        factValue: withRecordField(input.value, subject.record),
        confidence: 1,
        inferredBy: 'ask-hale',
        heard: input.heard,
        validFrom: input.now,
        memoryKind: 'lasting',
        memorySource: 'parent_message',
        sourcedAt: input.now,
        expiresAt: null,
        signalCount: 0,
      });
      factId = written.factId;
      superseded += written.supersededFactIds.length;
      const closed = await closeFacts(tx, {
        factIds: subject.unrecorded,
        closedAt: input.now,
        supersededBy: written.factId,
      });
      superseded += closed.closedFactIds.length;
    }
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.actor,
      actionTaken: 'memory_fact_retired',
      targetTable: 'family_memory_facts',
      targetId: factId,
      after: { corrected: true, applied: true, superseded },
    });
  });
  return { corrected: true };
}

function factTypeFor(factKey: string): 'logistic' | 'preference' {
  return isLastingFactKey(factKey) ? 'logistic' : 'preference';
}
