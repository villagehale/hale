import { GuardrailError, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { factsForContext } from '@hale/worker/memory-context';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCronGuardDeps } from '~/lib/cron/guards';
import { buildDistillTools, buildInferenceTools } from '~/lib/cron/inference-tools';
import { loadFamilyMemoryExport } from '~/lib/rights/export-memory';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-618. Every teen-name check reads the strings in a value, not its JSON text. As
 * JSON a newline is `\n`, whose `n` touches the name and hid it from the whole-word
 * match, so a multi-line fact about a 13+ child reached prompts and the export. A save
 * refused for naming a teen is refused before its audit row, so the words it carried
 * never land in the family-visible trail.
 */

const NOW = new Date('2026-11-08T06:00:00.000Z');
const TEEN_NAME = 'Tamsin';
const MULTILINE_TEEN = { note: `quick one\n${TEEN_NAME} has debate on Saturdays` };
const MULTILINE_PLAIN = { note: 'quick one\nlibrary on Sundays' };
const CLASS = { memoryClass: 'enduring', disposition: 'confirmed' } as const;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seed() {
  const { familyId, parentUserId } = await seedFamily(db.database);
  const [kid, teen] = await db.database
    .insert(schema.children)
    .values([
      { familyId, name: 'Pip', dateOfBirth: '2023-01-10' },
      { familyId, name: TEEN_NAME, dateOfBirth: '2012-02-01' },
    ])
    .returning({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    });
  if (!kid || !teen) throw new Error('children insert returned no rows');
  return { familyId, parentUserId, kid, teen };
}

async function storedFactKeys(familyId: string) {
  const rows = await db.database
    .select({ factKey: schema.familyMemoryFacts.factKey })
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
  return rows.map((row) => row.factKey).sort();
}

async function toolAudits(familyId: string) {
  return db.database
    .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, familyId), like(schema.auditLog.actionTaken, 'tool:%')),
    );
}

function tool(name: string) {
  const all = [...buildInferenceTools(db.database, NOW), ...buildDistillTools(db.database, NOW)];
  const found = all.find((t) => t.name === name);
  if (!found) throw new Error(`no ${name} tool`);
  return found;
}

function invoke(name: string, familyId: string, input: Record<string, unknown>) {
  return invokeTool(
    tool(name),
    input,
    { familyId, actor: 'system' },
    buildCronGuardDeps(db.database),
  );
}

async function refusal(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

describe('a multi-line fact naming a 13+ child', () => {
  it('never reaches a prompt, and a multi-line fact that names none does', async () => {
    const { familyId } = await seed();
    const fact = (factKey: string, factValue: unknown) => ({
      familyId,
      factType: 'preference' as const,
      factKey,
      factValue,
      confidence: 0.9,
      validFrom: new Date('2026-10-01T00:00:00.000Z'),
    });
    await db.database
      .insert(schema.familyMemoryFacts)
      .values([fact('saturday_plan', MULTILINE_TEEN), fact('sunday_plan', MULTILINE_PLAIN)]);

    const facts = await factsForContext(db.database, familyId, { now: NOW, limit: 10 });
    expect(facts.map((row) => row.factKey)).toEqual(['sunday_plan']);
  });

  it('is withheld as teen in the right-to-access copy, and one that names none is not', async () => {
    const { familyId, parentUserId, kid, teen } = await seed();
    await db.database.insert(schema.familyMemoryFacts).values([
      { familyId, factType: 'logistic', factKey: 'saturday_plan', factValue: MULTILINE_TEEN },
      { familyId, factType: 'logistic', factKey: 'sunday_plan', factValue: MULTILINE_PLAIN },
    ]);

    const exported = await loadFamilyMemoryExport(
      db.database,
      familyId,
      [kid, teen],
      { userId: parentUserId },
      NOW,
    );
    const byKey = new Map(exported.facts.map((row) => [row.factKey, row]));
    expect(byKey.get('sunday_plan')).toMatchObject({ withheld: null, value: MULTILINE_PLAIN });
    expect(JSON.stringify(exported.facts)).not.toContain(TEEN_NAME);
    expect(exported.facts.filter((row) => row.withheld === 'teen')).toHaveLength(1);
  });
});

describe('a save that names a 13+ child writes no fact and no audit row', () => {
  it('save_memory: a name after a newline in an object value', async () => {
    const { familyId } = await seed();
    const err = await refusal(
      invoke('save_memory', familyId, {
        childId: null,
        factType: 'routine',
        factKey: 'weekend',
        factValue: { w: `Ava\n${TEEN_NAME}` },
        confidence: 0.9,
        ...CLASS,
      }),
    );
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err).toMatchObject({ rail: 'child_content' });
    expect((err as Error).message).toContain('names_teen');
    expect(await storedFactKeys(familyId)).toEqual([]);
    expect(await toolAudits(familyId)).toEqual([]);
  });

  it('save_child_fact: the summary names the teen', async () => {
    const { familyId, kid } = await seed();
    const err = await refusal(
      invoke('save_child_fact', familyId, {
        childId: kid.id,
        category: 'concerns',
        factKey: 'sibling_worry',
        summary: `Pip misses ${TEEN_NAME} since the breakup`,
        confidence: 0.9,
        ...CLASS,
      }),
    );
    expect(err).toMatchObject({ rail: 'child_content' });
    expect(await storedFactKeys(familyId)).toEqual([]);
    expect(await toolAudits(familyId)).toEqual([]);
  });

  it('positive control: a multi-line save that names no teen is stored and audited', async () => {
    const { familyId } = await seed();
    await expect(
      invoke('save_memory', familyId, {
        childId: null,
        factType: 'routine',
        factKey: 'weekend',
        factValue: { w: 'Ava\nlibrary on Sundays' },
        confidence: 0.9,
        ...CLASS,
      }),
    ).resolves.toMatchObject({ saved: true });
    expect(await storedFactKeys(familyId)).toEqual(['weekend']);
    expect((await toolAudits(familyId)).map((row) => row.actionTaken)).toEqual([
      'tool:save_memory',
    ]);
  });

  it('save_memory filed under the 13+ child is refused on child_content before any write', async () => {
    const { familyId, teen } = await seed();
    const err = await refusal(
      invoke('save_memory', familyId, {
        childId: teen.id,
        factType: 'routine',
        factKey: 'practice',
        factValue: 'practice on Tuesdays',
        confidence: 0.9,
        ...CLASS,
      }),
    );
    expect(err).toBeInstanceOf(GuardrailError);
    expect(err).toMatchObject({ rail: 'child_content' });
    expect(await storedFactKeys(familyId)).toEqual([]);
    expect(await toolAudits(familyId)).toEqual([]);
  });
});

describe('save_memory names a source from this run’s redacted snapshot only', () => {
  async function seedEvent(
    familyId: string,
    payload: Record<string, unknown>,
    childId: string | null = null,
  ) {
    const [row] = await db.database
      .insert(schema.events)
      .values({
        familyId,
        childId,
        source: 'sms',
        eventType: 'message.received',
        payload,
        dedupHash: `leaves-${familyId}-${JSON.stringify(payload)}-${childId}`,
        receivedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.events.id });
    if (!row) throw new Error('event insert returned no row');
    return row.id;
  }

  function sourcedSave(familyId: string, factKey: string, sourceEventId: string) {
    return tool('save_memory').handler(
      {
        childId: null,
        factType: 'routine',
        factKey,
        factValue: 'Thursdays',
        confidence: 0.9,
        sourceEventId,
        ...CLASS,
      },
      { familyId, actor: 'system' },
    );
  }

  it('refuses an event the snapshot withheld for naming or being about a teen', async () => {
    const { familyId, teen } = await seed();
    const named = await seedEvent(familyId, { body: `ok\n${TEEN_NAME} got detention` });
    const filed = await seedEvent(familyId, { body: 'practice moved' }, teen.id);
    const shown = await seedEvent(familyId, { body: 'soccer moved to Thursdays' });

    expect(await sourcedSave(familyId, 'from_named', named)).toEqual({
      saved: false,
      reason: 'unknown_source_event',
    });
    expect(await sourcedSave(familyId, 'from_filed', filed)).toEqual({
      saved: false,
      reason: 'unknown_source_event',
    });
    // Positive control: an event the snapshot shows is a source.
    expect(await sourcedSave(familyId, 'from_shown', shown)).toMatchObject({ saved: true });
    expect(await storedFactKeys(familyId)).toEqual(['from_shown']);
  });
});
