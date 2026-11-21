import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { loadClaimShadowContext } from './candidate-rows';
import type { ClaimRowAlias } from './candidates';
import { bindDispatchClaimEnforce, createClaimEnforcer } from './claim-enforce';
import type { ClaimReader } from './claim-reader';
import { segmentSentences } from './sentences';
import { loadReconcileView } from './view';

/**
 * A parent's reminder about an event on their own connected Google Calendar, judged at
 * the dispatch seam under enforce: the real candidate-row loader, the real verifier, the
 * real DDL. Only the model's reading is stipulated, and it is the reading a faithful
 * reader gives for the rows it was actually offered: the calendar row titled like the
 * reminder when one is offered, otherwise `none`.
 *
 * The reminder cron reminds a mirror's owner (`family_events.created_by`) while a `kid`
 * verdict covers it, so that row must reach the reader when its owner is the recipient,
 * and must not when the recipient is the other parent or the row was judged adult.
 * Names are invented.
 */

const NOW = new Date('2026-11-19T23:00:00Z');
const STARTS = new Date('2026-11-20T15:00:00Z');
const ZONE = 'America/Toronto';
const TITLE = 'Swim lesson';
const REMINDER = `Heads up: ${TITLE} is tomorrow at 10:00 AM.`;

let db: TestDb;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('CLAIM_READ_OWN_MIRRORS_ENABLED', 'true');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function user(): Promise<string> {
  seq += 1;
  const [row] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:claim-mirror-${seq}`, name: 'Parent', timezone: ZONE })
    .returning({ id: schema.users.id });
  return row?.id as string;
}

async function seed() {
  const owner = await user();
  const coParent = await user();
  const [fam] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Household', provinceOrState: 'ON', onboardingStage: 'sms_active' })
    .returning({ id: schema.families.id });
  const familyId = fam?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: owner, role: 'primary_parent' },
    { familyId, userId: coParent, role: 'co_parent' },
  ]);
  return { familyId, owner, coParent };
}

async function mirror(
  familyId: string,
  createdBy: string,
  title: string,
  verdict: 'kid' | 'adult' = 'kid',
) {
  const [judged] = await db.database
    .insert(schema.kidRelevanceVerdicts)
    .values({
      familyId,
      source: 'google_calendar',
      itemKey: `g-mirror-${title}`,
      inputHash: 'h',
      verdict,
      decidedBy: 'model',
    })
    .returning({ id: schema.kidRelevanceVerdicts.id });
  await db.database.insert(schema.familyEvents).values({
    familyId,
    title,
    startsAt: STARTS,
    source: 'parent',
    googleEventId: `g-mirror-${title}`,
    createdBy,
    kidVerdictId: judged?.id as string,
  });
}

/** Cites the offered calendar row whose label is the event's title, else `none`. */
function citesTitledRow(title: string): ClaimReader & { offered: string[][] } {
  const reader = {
    offered: [] as string[][],
    async read(input: Parameters<ClaimReader['read']>[0]) {
      const calendar = [...input.candidates.byAlias.entries()].filter(
        ([, row]) => row.source === 'calendar',
      );
      reader.offered.push(calendar.map(([, row]) => row.what));
      const hit = calendar.find(([, row]) => row.what === title);
      const segments = segmentSentences(input.body, 'en');
      return {
        status: 'read' as const,
        segments,
        claims: [
          {
            segment: 0,
            kind: 'scheduled_event' as const,
            row: (hit ? hit[0] : 'none') as ClaimRowAlias,
          },
        ],
        usage: { input: 0, output: 0 },
        latencyMs: 0,
        attempts: 1 as const,
      };
    },
  };
  return reader;
}

function decide(reader: ClaimReader, input: { familyId: string; parentUserId: string }) {
  const enforcer = createClaimEnforcer({
    enforces: () => true,
    reader,
    loadContext: loadClaimShadowContext,
  });
  return bindDispatchClaimEnforce(db.database, enforcer).decide({
    ...input,
    body: REMINDER,
    now: NOW,
  });
}

describe('dispatch claim enforce · a reminder about the recipient’s own calendar', () => {
  it('a correct reminder for the recipient’s own mirrored event is clean', async () => {
    const { familyId, owner } = await seed();
    await mirror(familyId, owner, TITLE);
    const reader = citesTitledRow(TITLE);
    expect(await decide(reader, { familyId, parentUserId: owner })).toEqual({ status: 'clean' });
    expect(reader.offered).toEqual([[TITLE]]);
  });

  it('the same reminder to the other parent is unbacked: a mirror reaches only its owner', async () => {
    const { familyId, owner, coParent } = await seed();
    await mirror(familyId, owner, TITLE);
    const reader = citesTitledRow(TITLE);
    expect(await decide(reader, { familyId, parentUserId: coParent })).toMatchObject({
      status: 'unbacked',
    });
    expect(reader.offered).toEqual([[]]);
  });

  it('an own mirror judged adult is not offered, so a claim about it is unbacked', async () => {
    const { familyId, owner } = await seed();
    await mirror(familyId, owner, TITLE, 'adult');
    const reader = citesTitledRow(TITLE);
    expect(await decide(reader, { familyId, parentUserId: owner })).toMatchObject({
      status: 'unbacked',
    });
    expect(reader.offered).toEqual([[]]);
  });

  it('a reminder about an event on no row is still unbacked (positive control)', async () => {
    const { familyId, owner } = await seed();
    await mirror(familyId, owner, 'Dentist');
    const reader = citesTitledRow(TITLE);
    expect(await decide(reader, { familyId, parentUserId: owner })).toMatchObject({
      status: 'unbacked',
    });
  });

  it('a read that is not a one-to-one leg (a group coach turn) is not offered the mirror', async () => {
    const { familyId, owner } = await seed();
    await mirror(familyId, owner, TITLE);
    const reader = citesTitledRow(TITLE);
    const enforcer = createClaimEnforcer({
      enforces: () => true,
      reader,
      loadContext: loadClaimShadowContext,
    });
    await enforcer.read(db.database, {
      familyId,
      parentUserId: owner,
      now: NOW,
      body: REMINDER,
      view: await loadReconcileView(db.database, { familyId, now: NOW }),
      signal: new AbortController().signal,
      budgetMs: 15_000,
    });
    expect(reader.offered).toEqual([[]]);
  });

  it('with the flag dark the mirror is not offered, and the reminder stays refused', async () => {
    vi.stubEnv('CLAIM_READ_OWN_MIRRORS_ENABLED', '');
    const { familyId, owner } = await seed();
    await mirror(familyId, owner, TITLE);
    const reader = citesTitledRow(TITLE);
    expect(await decide(reader, { familyId, parentUserId: owner })).toMatchObject({
      status: 'unbacked',
    });
    expect(reader.offered).toEqual([[]]);
  });
});

describe('dispatch claim enforce · the refused verdict is kept', () => {
  async function refusedLeg() {
    const { familyId, owner } = await seed();
    await mirror(familyId, owner, 'Dentist');
    const enforcer = createClaimEnforcer({
      enforces: () => true,
      reader: citesTitledRow(TITLE),
      loadContext: loadClaimShadowContext,
    });
    const port = bindDispatchClaimEnforce(db.database, enforcer);
    const decision = await port.decide({
      familyId,
      parentUserId: owner,
      body: REMINDER,
      now: NOW,
    });
    if (decision.status !== 'unbacked') throw new Error(`expected unbacked: ${decision.status}`);
    const [message] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId: owner,
        channel: 'sms',
        direction: 'out',
        category: 'reminder',
        status: 'failed',
        errorCode: 'unbacked_claim',
      })
      .returning({ id: schema.channelMessages.id });
    const channelMessageId = message?.id as string;
    const stored = await port.recordRefusal({
      familyId,
      channelMessageId,
      refusal: decision.refusal,
    });
    const rows = await db.database
      .select()
      .from(schema.claimRefusals)
      .where(eq(schema.claimRefusals.channelMessageId, channelMessageId));
    return { stored, rows };
  }

  it('flag on: the row names the claim and the counts, and carries no text', async () => {
    vi.stubEnv('CLAIM_REFUSAL_STORE_ENABLED', 'true');
    const { stored, rows } = await refusedLeg();
    expect(stored).toBe('stored');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.claims).toEqual([
      {
        segment: 0,
        kind: 'scheduled_event',
        cited: 'none',
        status: 'refused',
        reason: 'no_scheduled_row',
        why: 'cited_none',
      },
    ]);
    expect(rows[0]?.candidates).toEqual({ offered: { calendar: 1 }, capped: [] });
    const wire = JSON.stringify(rows[0]);
    expect(wire).not.toContain(TITLE);
    expect(wire).not.toContain('Dentist');
  });

  it('flag dark: nothing is written', async () => {
    vi.stubEnv('CLAIM_REFUSAL_STORE_ENABLED', '');
    const { stored, rows } = await refusedLeg();
    expect(stored).toBe('off');
    expect(rows).toEqual([]);
  });

  it("only the exact value 'true' turns the store on", async () => {
    vi.stubEnv('CLAIM_REFUSAL_STORE_ENABLED', 'True');
    const { stored, rows } = await refusedLeg();
    expect(stored).toBe('off');
    expect(rows).toEqual([]);
  });
});
