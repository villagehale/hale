import { schema } from '@hale/db';
import { getMemorySlice } from '@hale/worker/memory-writer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { loadPlanFacts } from '~/lib/channel/plan/reply';
import { loadAgentContext } from '~/lib/coach/context';
import { buildInferenceTools } from '~/lib/cron/inference-tools';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { assembleMemoryBrief } from './brief';

/**
 * VIL-597 G9/G10/G12. Every prompt that carries family memory reads it one way. One
 * family holds one row of each kind a prompt must never see, next to two it must, and
 * each reader is asked for its slice.
 */

const NOW = new Date('2026-11-08T15:00:00.000Z');
const TEEN_NAME = 'Tamsin';

let db: TestDb;
let familyId: string;
let kidId: string;

const LIVE_KEYS = ['outdoor_play', 'kid_swim'];
const HIDDEN_KEYS = [
  'teen_pref',
  'weekend_plan',
  'pickup_this_week',
  'maybe_pref',
  'action_override:email_reply',
  'old_pref',
];
const LIVE_EPISODE = 'went to the library together';

beforeAll(async () => {
  db = await createTestDb();
  ({ familyId } = await seedFamily(db.database));
  const [kid, teen] = await db.database
    .insert(schema.children)
    .values([
      { familyId, name: 'Pip', dateOfBirth: '2023-01-10' },
      { familyId, name: TEEN_NAME, dateOfBirth: '2012-02-01' },
    ])
    .returning({ id: schema.children.id });
  kidId = kid?.id as string;
  const teenId = teen?.id as string;

  const fact = (
    factKey: string,
    summary: string,
    extra: Partial<typeof schema.familyMemoryFacts.$inferInsert> = {},
  ) => ({
    familyId,
    factType: 'preference' as const,
    factKey,
    factValue: { summary },
    confidence: 0.9,
    validFrom: new Date('2026-10-01T00:00:00.000Z'),
    ...extra,
  });
  await db.database.insert(schema.familyMemoryFacts).values([
    fact('outdoor_play', 'loves outdoor play'),
    fact('kid_swim', 'Pip likes the pool', { childId: kidId }),
    fact('teen_pref', 'teen detail', { childId: teenId }),
    fact('weekend_plan', `${TEEN_NAME} has debate club on Saturdays`),
    fact('pickup_this_week', 'grandma does pickup', {
      memoryKind: 'temporary',
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    }),
    fact('maybe_pref', 'might like pottery', { confidence: 0.5 }),
    fact('action_override:email_reply', 'a tool address'),
    fact('old_pref', 'used to like trains', { validUntil: new Date('2026-10-15T00:00:00.000Z') }),
  ]);

  const episode = (
    summary: string,
    extra: Partial<typeof schema.familyMemoryEpisodes.$inferInsert> = {},
  ) => ({
    familyId,
    occurredAt: new Date('2026-11-05T12:00:00.000Z'),
    episodeType: 'outing',
    summary,
    ...extra,
  });
  await db.database
    .insert(schema.familyMemoryEpisodes)
    .values([
      episode(LIVE_EPISODE),
      episode('deleted outing', { deletedAt: new Date('2026-11-06T00:00:00.000Z') }),
      episode('teen outing', { childId: teenId }),
      episode(`${TEEN_NAME} started a new job`),
    ]);
  await db.database.insert(schema.events).values({
    familyId,
    childId: teenId,
    source: 'sms',
    eventType: 'message.received',
    payload: { body: 'teen secret' },
    dedupHash: 'context-read-teen-event',
    receivedAt: new Date('2026-11-07T12:00:00.000Z'),
  });
});

afterAll(async () => {
  await db.close();
});

function expectOnlyLive(text: string, liveKeys: readonly string[] = LIVE_KEYS) {
  for (const key of liveKeys) expect(text).toContain(key);
  for (const key of HIDDEN_KEYS) expect(text).not.toContain(key);
  expect(text).not.toContain(TEEN_NAME);
  expect(text).not.toContain('teen detail');
}

function expectOnlyLiveEpisodes(summaries: readonly string[]) {
  expect(summaries).toEqual([LIVE_EPISODE]);
}

describe('every prompt reads family memory one way', () => {
  it('the coach', async () => {
    const context = await loadAgentContext(
      {
        familyId,
        question: 'what should we do this weekend?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );
    expect(context.memoryFacts.map((f) => f.factKey).sort()).toEqual([...LIVE_KEYS].sort());
    expectOnlyLiveEpisodes(context.recentEpisodes.map((e) => e.summary));
    expectOnlyLive(context.memoryBrief.text);
  });

  it('the memory brief', async () => {
    const brief = await assembleMemoryBrief(db.database, familyId, NOW);
    expectOnlyLive(brief.text);
  });

  it('the drafter', async () => {
    const slice = await getMemorySlice(familyId, db.database, NOW);
    expect(slice.facts.map((f) => f.factKey).sort()).toEqual([...LIVE_KEYS].sort());
    expectOnlyLiveEpisodes(slice.episodes.map((e) => e.summary));
  });

  it('the find slice', async () => {
    const reader = productionActivityFamilyReader();
    const fit = await reader.familyFit?.(db.database, familyId, NOW);
    expect(fit?.preferences.map((p) => p.key).sort()).toEqual([...LIVE_KEYS].sort());
  });

  it('the plan composer reads family-wide facts only', async () => {
    expect(await loadPlanFacts(db.database, familyId, NOW)).toEqual(['loves outdoor play']);
  });

  it('the nightly inferencer', async () => {
    const tool = buildInferenceTools(db.database, NOW).find((t) => t.name === 'read_recent_memory');
    const snapshot = (await tool?.handler({}, { familyId, actor: 'system' })) as {
      children: { name: string | null; stage: string }[];
      currentFacts: { factKey: string }[];
      recentEpisodes: { summary: string }[];
    };
    expect(snapshot.currentFacts.map((f) => f.factKey).sort()).toEqual([...LIVE_KEYS].sort());
    expectOnlyLiveEpisodes(snapshot.recentEpisodes.map((e) => e.summary));
    expectOnlyLive(JSON.stringify(snapshot));
    expect(JSON.stringify(snapshot)).not.toContain('teen secret');
    // The roster a save names its subject from: the teen is there by stage, nameless.
    expect(
      snapshot.children
        .map((c) => ({ name: c.name, stage: c.stage }))
        .sort((a, b) => a.stage.localeCompare(b.stage)),
    ).toEqual([
      { name: null, stage: 'teenager' },
      { name: 'Pip', stage: 'toddler' },
    ]);
  });
});
