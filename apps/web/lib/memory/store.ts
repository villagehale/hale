import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { linqGroupCoparentEnabled } from '~/lib/channel/linq/config';
import { replyFrame, replyProse } from '~/lib/channel/reply-copy/apply';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { promptKind, readDisposition } from './classify-write';
import { writeFact } from './facts';
import { forgetFamilyFact } from './forget';
import {
  type MemoryKindEnv,
  type MemoryKindLanguage,
  type MemoryRecallItem,
  type MemorySource,
  type PromotionSignal,
  applyPromotionSignal,
  classifyMemoryWrite,
  deliverMemoryKindCopy,
  familyMemoryKindsCopyLocked,
  familyMemoryKindsEnabled,
  includeInRecommendations,
  isLastingFactKey,
  memoryKindCopy,
  memoryKindLanguage,
  memoryRecallParts,
  memoryTextOverlaps,
  paginateMemoryRecall,
  parseMemoryParentIntent,
  renderMemoryCorrected,
  renderMemoryForgotten,
  renderMemoryGroupSync,
  toFamilyMemoryExportFact,
} from './kinds';
import { isReceiptKey } from './lexicon';
import { SYNTHESIS_WRITERS } from './synthesis';

const BELIEF_WRITERS = new Set<string>(SYNTHESIS_WRITERS);
const RECOMMENDATION_LIMIT = 40;
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
 * Teen-attributed rows and control-plane receipts stay out.
 */
export async function recallFamilyMemory(
  database: Database,
  input: { familyId: string; now: Date },
): Promise<RecallFact[]> {
  const teens = await teenIds(database, input.familyId, input.now);
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
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .orderBy(desc(schema.familyMemoryFacts.sourcedAt))
    .limit(40);

  return rows
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
      };
    });
}

export interface ParentMemoryResult {
  claimed: boolean;
  outcome: string;
  /** Null unless both copy gates are exactly true. */
  reply: string | null;
  forgotten: number;
  corrected: number;
  groupSync: { synced: boolean; skipped: string };
}

async function familyDoor(
  database: Database,
  familyId: string,
): Promise<{ groupChatId: string | null; language: MemoryKindLanguage }> {
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
    language: memoryKindLanguage(family?.primaryLanguage),
  };
}

async function originChatId(database: Database, messageId: string | null): Promise<string | null> {
  if (!messageId) return null;
  const [row] = await database
    .select({ providerChatId: schema.channelMessages.providerChatId })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, messageId))
    .limit(1);
  return row?.providerChatId ?? null;
}

export async function syncMemoryDecisionToGroup(
  database: Database,
  input: {
    familyId: string;
    originChatId: string | null;
    language: MemoryKindLanguage;
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
  let body: string;
  try {
    body = renderMemoryGroupSync(input.language, input.change, who);
  } catch {
    return { synced: false, skipped: 'unrendered' };
  }
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

function recallItems(facts: readonly RecallFact[]): MemoryRecallItem[] {
  const items: MemoryRecallItem[] = [];
  for (const fact of facts) {
    if (fact.source === 'receipt') continue;
    const value = displayFactValue(fact.factValue);
    if (!value) continue;
    const source = fact.source as MemoryRecallItem['source'];
    const kind = fact.kind as MemoryRecallItem['kind'];
    items.push({ key: fact.factKey, value, source, kind });
  }
  return items;
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

/**
 * A parent asked what Hale knows, or asked it to forget or correct a fact.
 * Flag off is a no-op before any read. The reply text is withheld unless
 * the copy gate is exactly true. A 1:1 decision is mirrored to the claimed
 * group and nowhere else — this function never opens a 1:1.
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
    /** Injected model. Absent: the locked sentence, and the model is not called. */
    replyClient?: AgentClient | null;
  },
): Promise<ParentMemoryResult> {
  const env = input.env ?? process.env;
  const idle: ParentMemoryResult = {
    claimed: false,
    outcome: 'flag_off',
    reply: null,
    forgotten: 0,
    corrected: 0,
    groupSync: { synced: false, skipped: 'not_run' },
  };
  if (!familyMemoryKindsEnabled(env)) return idle;

  const intent = parseMemoryParentIntent(input.body);
  if (!intent) return { ...idle, outcome: 'not_memory' };

  const door = await familyDoor(database, input.familyId);
  const origin = await originChatId(database, input.inboundChannelMessageId);

  const layer = {
    client: await resolveReplyClient(input.replyClient),
    database,
    familyId: input.familyId,
    language: door.language,
    audience: 'direct' as const,
    flagOn: familyMemoryKindsCopyLocked(env),
    surface: 'memory' as const,
  };

  if (intent.kind === 'recall') {
    const facts = await recallFamilyMemory(database, { familyId: input.familyId, now: input.now });
    let reply: string | null = null;
    try {
      const parts = memoryRecallParts(door.language, recallItems(facts));
      let body: string;
      if (parts.empty) {
        body = await replyProse(layer, { fallback: parts.empty, facts: [] });
      } else {
        const frame = await replyFrame(layer, {
          header: parts.header,
          footer: parts.footer,
          facts: parts.lines,
        });
        body = paginateMemoryRecall(frame.header, parts.lines, frame.footer).join('\n\n');
      }
      reply = gatedReply(body, env);
    } catch {
      reply = null;
    }
    return {
      claimed: true,
      outcome: 'recalled',
      reply,
      forgotten: 0,
      corrected: 0,
      groupSync: { synced: false, skipped: 'not_a_decision' },
    };
  }

  if (intent.kind === 'forget') {
    const forgotten = await forgetMatchingFacts(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      now: input.now,
      needle: intent.needle,
    });
    const refusedOnly = forgotten.forgotten === 0 && forgotten.refused > 0;
    const lockedForget =
      forgotten.forgotten > 0
        ? renderMemoryForgotten(door.language, forgotten.keys)
        : memoryKindCopy(door.language, refusedOnly ? 'refused' : 'nothing');
    const body = refusedOnly
      ? lockedForget
      : await replyProse(layer, { fallback: lockedForget, facts: forgotten.keys });
    const groupSync =
      forgotten.forgotten > 0
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
    return {
      claimed: true,
      outcome:
        forgotten.forgotten > 0 ? 'forgotten' : forgotten.refused > 0 ? 'refused' : 'nothing',
      reply: gatedReply(body, env),
      forgotten: forgotten.forgotten,
      corrected: 0,
      groupSync,
    };
  }

  const corrected = await correctFamilyFact(database, {
    familyId: input.familyId,
    actor: input.parentUserId,
    factKey: intent.factKey ?? '',
    value: intent.value ?? '',
    now: input.now,
  });
  const groupSync = corrected.corrected
    ? await syncMemoryDecisionToGroup(database, {
        familyId: input.familyId,
        originChatId: origin,
        language: door.language,
        actorUserId: input.parentUserId,
        change: 'correct',
        env,
        sendGroup: input.sendGroup,
      })
    : { synced: false, skipped: 'nothing_to_sync' };
  const lockedCorrect = corrected.corrected
    ? renderMemoryCorrected(door.language, intent.factKey ?? '', intent.value ?? '')
    : memoryKindCopy(door.language, 'refused');
  const correctedBody = corrected.corrected
    ? await replyProse(layer, {
        fallback: lockedCorrect,
        facts: [intent.factKey ?? '', intent.value ?? ''],
      })
    : lockedCorrect;
  return {
    claimed: true,
    outcome: corrected.corrected ? 'corrected' : 'refused',
    reply: gatedReply(correctedBody, env),
    forgotten: 0,
    corrected: corrected.corrected ? 1 : 0,
    groupSync,
  };
}

async function forgetMatchingFacts(
  database: Database,
  input: { familyId: string; actor: string; now: Date; needle: string | null },
): Promise<{ forgotten: number; refused: number; keys: string[] }> {
  const teens = await teenIds(database, input.familyId, input.now);
  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      childId: schema.familyMemoryFacts.childId,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      inferredBy: schema.familyMemoryFacts.inferredBy,
      sourcedAt: schema.familyMemoryFacts.sourcedAt,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .orderBy(desc(schema.familyMemoryFacts.sourcedAt));

  const beliefs = rows.filter((row) => (!row.childId || !teens.has(row.childId)) && beliefRow(row));
  const targets =
    input.needle === null
      ? beliefs.slice(0, 1)
      : beliefs.filter((row) => memoryTextOverlaps(row.factKey, row.factValue, input.needle ?? ''));

  let forgotten = 0;
  let refused = 0;
  const keys: string[] = [];
  for (const row of targets) {
    const result = await forgetFamilyFact(database, {
      familyId: input.familyId,
      factId: row.id,
      actor: input.actor,
      now: input.now,
    });
    forgotten += result.forgotten;
    if (result.forgotten > 0) keys.push(row.factKey);
    refused += result.refusedControlPlane + result.refusedWriter;
  }
  if (targets.length === 0 && input.needle === null) {
    const receipts = rows.filter((row) => isReceiptKey(row.factKey));
    if (receipts.length > 0) refused += 1;
  }
  return { forgotten, refused, keys };
}

async function correctFamilyFact(
  database: Database,
  input: { familyId: string; actor: string; factKey: string; value: string; now: Date },
): Promise<{ corrected: boolean }> {
  if (isReceiptKey(input.factKey) || !input.factKey || !input.value) return { corrected: false };
  const teens = await teenIds(database, input.familyId, input.now);
  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
      inferredBy: schema.familyMemoryFacts.inferredBy,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        eq(schema.familyMemoryFacts.factKey, input.factKey),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );

  const live = rows.filter((row) => !row.childId || !teens.has(row.childId));
  const subjects: Array<{
    childId: string | null;
    factType: 'preference' | 'routine' | 'medical' | 'logistic' | 'relationship' | 'voice';
  }> =
    live.length > 0
      ? live.map((row) => ({ childId: row.childId, factType: row.factType }))
      : [{ childId: null, factType: factTypeFor(input.factKey) }];

  await database.transaction(async (tx) => {
    let superseded = 0;
    let factId = input.familyId;
    for (const subject of subjects) {
      const written = await writeFact(tx, {
        familyId: input.familyId,
        childId: subject.childId,
        factType: subject.factType,
        factKey: input.factKey,
        factValue: input.value,
        confidence: 1,
        inferredBy: 'ask-hale',
        validFrom: input.now,
        memoryKind: 'lasting',
        memorySource: 'parent_message',
        sourcedAt: input.now,
        expiresAt: null,
        signalCount: 0,
      });
      factId = written.factId;
      superseded += written.supersededFactIds.length;
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
