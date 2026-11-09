import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { namesAny } from '@hale/worker/memory-context';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import { toFamilyMemoryExportFact } from '~/lib/memory/kinds';

/**
 * VIL-597 G18 · what Hale remembers about a family, in the right-to-access copy: every
 * fact (including the ones a later write replaced, with when), every episode (including
 * the ones a parent removed, with when), the open and closed jobs Hale tracked, and the
 * promises Hale made.
 *
 * Every row keeps its dates and its type. Its words are withheld, and `withheld`
 * names why, when:
 *   - `teen`: it is about a 13+ child, or its text names one (rule #1, as for the
 *     trail; the words become the trail's placeholder);
 *   - `another_adult`: it came from another adult's one-to-one thread. Decision R7:
 *     co-parents share logistics; anything else said in one adult's 1:1 stays theirs;
 *   - `source_not_recorded`: the household has more than one adult and the row does
 *     not record which one it came from. A fact records no adult, so only a
 *     logistics or routine fact, or one read from a calendar or a receipt, is shared
 *     by source.
 * A group-thread row and the requester's own 1:1 row are theirs to read. An episode is
 * a quick log from the family's shared log view, so it is shared by source; a removed
 * episode keeps no words. Child ids stay internal; a younger child is named.
 */
export type MemoryWithheldReason = 'teen' | 'another_adult' | 'source_not_recorded';

export interface FamilyMemoryExport {
  facts: {
    child: string | null;
    factType: string;
    factKey: string | null;
    value: unknown;
    kind: string;
    source: string;
    confidence: number;
    sourcedAt: string;
    expiresAt: string | null;
    /** When a later write replaced the fact. Null while it is what Hale believes. */
    invalidatedAt: string | null;
    withheld: MemoryWithheldReason | null;
  }[];
  episodes: {
    child: string | null;
    occurredAt: string;
    episodeType: string;
    /** Null once the parent removed it. */
    summary: string | null;
    /** When the parent removed it. Hale keeps the row for the audit trail. */
    deletedAt: string | null;
    withheld: MemoryWithheldReason | null;
  }[];
  workstreams: {
    title: string | null;
    status: string;
    nextStep: string | null;
    checkBackAt: string | null;
    createdAt: string;
    closedAt: string | null;
    expiresAt: string;
    withheld: MemoryWithheldReason | null;
  }[];
  commitments: {
    kind: string;
    summary: string | null;
    dueAt: string;
    createdAt: string;
    fulfilledAt: string | null;
    cancelledAt: string | null;
    withheld: MemoryWithheldReason | null;
  }[];
}

interface ExportChild {
  id: string;
  name: string;
  dateOfBirth: string;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

const SHARED_FACT_TYPES: ReadonlySet<string> = new Set(['logistic', 'routine']);
const SHARED_FACT_SOURCES: ReadonlySet<string> = new Set(['calendar', 'receipt']);

interface MessageSource {
  parentUserId: string;
  inGroup: boolean | null;
}

/** The `channel_messages` rows a workstream or commitment names as its provenance. */
async function loadMessageSources(
  database: Database,
  familyId: string,
  messageIds: readonly string[],
): Promise<Map<string, MessageSource>> {
  if (messageIds.length === 0) return new Map();
  const messages = schema.channelMessages;
  const rows = await database
    .select({
      id: sql<string>`${messages.id}::text`,
      parentUserId: messages.parentUserId,
      inGroup: messages.inGroup,
    })
    .from(messages)
    .where(
      and(eq(messages.familyId, familyId), inArray(sql`${messages.id}::text`, [...messageIds])),
    );
  return new Map(rows.map((row) => [row.id, row]));
}

export async function loadFamilyMemoryExport(
  database: Database,
  familyId: string,
  children: readonly ExportChild[],
  requester: { userId: string; householdAdults: number },
  now: Date,
): Promise<FamilyMemoryExport> {
  const teens = children.filter((child) => deriveStage(child.dateOfBirth, now) === 'teenager');
  const teenIds = new Set(teens.map((child) => child.id));
  const teenNames = teens.map((child) => child.name);
  const nameById = new Map(children.map((child) => [child.id, child.name]));
  const isPrivate = (childIds: readonly (string | null)[], texts: readonly string[]) =>
    childIds.some((id) => id !== null && teenIds.has(id)) ||
    texts.some((text) => namesAny(text, teenNames));
  const childName = (childId: string | null) =>
    childId === null || teenIds.has(childId) ? null : (nameById.get(childId) ?? null);

  const [factRows, episodeRows, workstreamRows, commitmentRows] = await Promise.all([
    database
      .select()
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId))
      .orderBy(schema.familyMemoryFacts.createdAt),
    database
      .select()
      .from(schema.familyMemoryEpisodes)
      .where(eq(schema.familyMemoryEpisodes.familyId, familyId))
      .orderBy(schema.familyMemoryEpisodes.occurredAt),
    database
      .select()
      .from(schema.familyWorkstreams)
      .where(eq(schema.familyWorkstreams.familyId, familyId))
      .orderBy(schema.familyWorkstreams.createdAt),
    database
      .select()
      .from(schema.agentCommitments)
      .where(eq(schema.agentCommitments.familyId, familyId))
      .orderBy(schema.agentCommitments.createdAt),
  ]);
  const sources = await loadMessageSources(database, familyId, [
    ...workstreamRows.map((row) => row.createdFrom),
    ...commitmentRows.map((row) => row.createdFrom),
  ]);
  const unattributed: MemoryWithheldReason | null =
    requester.householdAdults <= 1 ? null : 'source_not_recorded';
  const bySource = (messageId: string): MemoryWithheldReason | null => {
    const source = sources.get(messageId);
    if (!source) return unattributed;
    if (source.inGroup === true || source.parentUserId === requester.userId) return null;
    return 'another_adult';
  };
  const withheldFor = (
    childIds: readonly (string | null)[],
    texts: readonly string[],
    sourceReason: MemoryWithheldReason | null,
  ): MemoryWithheldReason | null => (isPrivate(childIds, texts) ? 'teen' : sourceReason);
  const words = <T>(withheld: MemoryWithheldReason | null, text: T): T | string | null => {
    if (withheld === null) return text;
    return withheld === 'teen' ? TEEN_REDACTED_PLACEHOLDER : null;
  };

  return {
    facts: factRows.map((row) => {
      const exported = toFamilyMemoryExportFact(row);
      const sharedBySource =
        SHARED_FACT_TYPES.has(row.factType) || SHARED_FACT_SOURCES.has(row.memorySource);
      const withheld = withheldFor(
        [row.childId],
        [row.factKey, textOf(row.factValue)],
        sharedBySource ? null : unattributed,
      );
      return {
        child: childName(row.childId),
        factType: row.factType,
        factKey: words(withheld, row.factKey),
        value: words(withheld, row.factValue),
        kind: exported.kind,
        source: exported.source,
        confidence: row.confidence,
        sourcedAt: exported.sourcedAt,
        expiresAt: exported.expiresAt,
        invalidatedAt: exported.invalidatedAt,
        withheld,
      };
    }),
    episodes: episodeRows.map((row) => {
      const withheld = withheldFor([row.childId], [row.summary], null);
      return {
        child: childName(row.childId),
        occurredAt: row.occurredAt.toISOString(),
        episodeType: row.episodeType,
        summary: row.deletedAt === null ? words(withheld, row.summary) : null,
        deletedAt: iso(row.deletedAt),
        withheld,
      };
    }),
    workstreams: workstreamRows.map((row) => {
      const withheld = withheldFor(
        row.childIds,
        [row.title, row.nextStep ?? ''],
        bySource(row.createdFrom),
      );
      return {
        title: words(withheld, row.title),
        status: row.status,
        nextStep: withheld === null ? row.nextStep : null,
        checkBackAt: iso(row.checkBackAt),
        createdAt: row.createdAt.toISOString(),
        closedAt: iso(row.closedAt),
        expiresAt: row.expiresAt.toISOString(),
        withheld,
      };
    }),
    commitments: commitmentRows.map((row) => {
      const withheld = withheldFor([row.subjectChildId], [row.summary], bySource(row.createdFrom));
      return {
        kind: row.commitmentKind,
        summary: words(withheld, row.summary),
        dueAt: row.dueAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        fulfilledAt: iso(row.fulfilledAt),
        cancelledAt: iso(row.cancelledAt),
        withheld,
      };
    }),
  };
}
