import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { aliasesForFactKey, isReceiptKey } from './lexicon';

/** How many live facts one digest run indexes. The next run continues; inserts conflict-do-nothing. */
export const MAX_ALIAS_INDEX_PER_FAMILY = 100;

export interface AliasIndexResult {
  candidates: number;
  written: number;
}

/**
 * Writes lexicon aliases for live, non-teen, non-receipt facts. Idempotent.
 * `applied: false` counts candidates and writes nothing.
 */
export async function indexFamilyAliases(
  database: Database,
  input: { familyId: string; teenChildIds: ReadonlySet<string>; applied: boolean },
): Promise<AliasIndexResult> {
  const facts = await database
    .select({
      id: schema.familyMemoryFacts.id,
      factKey: schema.familyMemoryFacts.factKey,
      childId: schema.familyMemoryFacts.childId,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .orderBy(desc(schema.familyMemoryFacts.confidence), desc(schema.familyMemoryFacts.validFrom))
    .limit(MAX_ALIAS_INDEX_PER_FAMILY);

  const rows: Array<{
    familyId: string;
    factId: string;
    aliasNorm: string;
    source: 'key' | 'lexicon';
  }> = [];
  for (const fact of facts) {
    if (fact.childId !== null && input.teenChildIds.has(fact.childId)) continue;
    if (isReceiptKey(fact.factKey)) continue;
    for (const alias of aliasesForFactKey(fact.factKey)) {
      rows.push({
        familyId: input.familyId,
        factId: fact.id,
        aliasNorm: alias.aliasNorm,
        source: alias.source,
      });
    }
  }
  if (!input.applied || rows.length === 0) {
    return { candidates: facts.length, written: 0 };
  }

  const inserted = await database
    .insert(schema.familyMemoryAliases)
    .values(rows)
    .onConflictDoNothing({
      target: [schema.familyMemoryAliases.factId, schema.familyMemoryAliases.aliasNorm],
    })
    .returning({ id: schema.familyMemoryAliases.id });
  return { candidates: facts.length, written: inserted.length };
}
