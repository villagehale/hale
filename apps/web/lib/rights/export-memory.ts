import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { namesAny } from '@hale/worker/memory-context';
import { eq } from 'drizzle-orm';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import { toFamilyMemoryExportFact } from '~/lib/memory/kinds';

/**
 * VIL-597 G18 · what Hale remembers about a family, in the right-to-access copy: every
 * fact (including the ones a later write replaced, with when), every episode (including
 * the ones a parent removed, with when), the open and closed jobs Hale tracked, and the
 * promises Hale made.
 *
 * Rule #1 at the most-private level, as for the trail: a row about a 13+ child, or a
 * family-wide row whose text names one, keeps its dates and its type and loses its
 * words to the trail's placeholder. Child ids stay internal; a younger child is named.
 */
export interface FamilyMemoryExport {
  facts: {
    child: string | null;
    factType: string;
    factKey: string;
    value: unknown;
    kind: string;
    source: string;
    confidence: number;
    sourcedAt: string;
    expiresAt: string | null;
    /** When a later write replaced the fact. Null while it is what Hale believes. */
    invalidatedAt: string | null;
  }[];
  episodes: {
    child: string | null;
    occurredAt: string;
    episodeType: string;
    summary: string;
    /** When the parent removed it. Hale keeps the row for the audit trail. */
    deletedAt: string | null;
  }[];
  workstreams: {
    title: string;
    status: string;
    nextStep: string | null;
    checkBackAt: string | null;
    createdAt: string;
    closedAt: string | null;
    expiresAt: string;
  }[];
  commitments: {
    kind: string;
    summary: string;
    dueAt: string;
    createdAt: string;
    fulfilledAt: string | null;
    cancelledAt: string | null;
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

export async function loadFamilyMemoryExport(
  database: Database,
  familyId: string,
  children: readonly ExportChild[],
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

  return {
    facts: factRows.map((row) => {
      const exported = toFamilyMemoryExportFact(row);
      const hidden = isPrivate([row.childId], [row.factKey, textOf(row.factValue)]);
      return {
        child: childName(row.childId),
        factType: row.factType,
        factKey: hidden ? TEEN_REDACTED_PLACEHOLDER : row.factKey,
        value: hidden ? TEEN_REDACTED_PLACEHOLDER : row.factValue,
        kind: exported.kind,
        source: exported.source,
        confidence: row.confidence,
        sourcedAt: exported.sourcedAt,
        expiresAt: exported.expiresAt,
        invalidatedAt: exported.invalidatedAt,
      };
    }),
    episodes: episodeRows.map((row) => ({
      child: childName(row.childId),
      occurredAt: row.occurredAt.toISOString(),
      episodeType: row.episodeType,
      summary: isPrivate([row.childId], [row.summary]) ? TEEN_REDACTED_PLACEHOLDER : row.summary,
      deletedAt: iso(row.deletedAt),
    })),
    workstreams: workstreamRows.map((row) => {
      const hidden = isPrivate(row.childIds, [row.title, row.nextStep ?? '']);
      return {
        title: hidden ? TEEN_REDACTED_PLACEHOLDER : row.title,
        status: row.status,
        nextStep: hidden ? null : row.nextStep,
        checkBackAt: iso(row.checkBackAt),
        createdAt: row.createdAt.toISOString(),
        closedAt: iso(row.closedAt),
        expiresAt: row.expiresAt.toISOString(),
      };
    }),
    commitments: commitmentRows.map((row) => ({
      kind: row.commitmentKind,
      summary: isPrivate([row.subjectChildId], [row.summary])
        ? TEEN_REDACTED_PLACEHOLDER
        : row.summary,
      dueAt: row.dueAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      fulfilledAt: iso(row.fulfilledAt),
      cancelledAt: iso(row.cancelledAt),
    })),
  };
}
