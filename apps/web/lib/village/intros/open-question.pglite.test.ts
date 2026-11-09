import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { introAskDedupeKey } from './run';

/**
 * VIL-302 · the intro asks are dated through the router's REAL reader.
 *
 * A bare yes is read against Hale's newest ask first, and an undated question turns
 * that preference off for the whole list. The unit tests inject the sources, so
 * blinding the production intro readers would fail nothing there. This file reads the
 * way production does, against real Postgres.
 */

const NOW = new Date('2026-08-20T18:18:00.000Z');
const OPT_IN_ASKED = new Date('2026-08-20T09:00:00.000Z');
const CARD_ASKED = new Date('2026-08-20T10:30:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(label: string): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: `Family ${label}`, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:intro-reader-${label}`, name: `Parent ${label}` })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  return { familyId, parentUserId };
}

describe('the intro asks, through the production reader', () => {
  it('dates the opt-in by its ledger row and the card by its own side', async () => {
    const asked = await seedFamily('a');
    const other = await seedFamily('b');
    await db.database.insert(schema.channelMessages).values({
      familyId: asked.familyId,
      parentUserId: asked.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'village_intro',
      status: 'sent',
      dedupeKey: introAskDedupeKey(asked.familyId),
      createdAt: OPT_IN_ASKED,
    });
    const askedIsA = asked.familyId < other.familyId;
    await db.database.insert(schema.villageIntroProposals).values({
      fsa: 'A1A',
      status: 'proposed',
      stage: 'toddler',
      familyAId: askedIsA ? asked.familyId : other.familyId,
      familyBId: askedIsA ? other.familyId : asked.familyId,
      // Only the side under test was asked at CARD_ASKED; the other side's time must not leak.
      familyAAskedAt: askedIsA ? CARD_ASKED : NOW,
      familyBAskedAt: askedIsA ? NOW : CARD_ASKED,
      expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    });

    const questions = await defaultOpenQuestionReader().open(db.database, { ...asked, now: NOW });

    expect(
      questions
        .map((q) => ({ kind: q.kind, askedAt: q.askedAt }))
        .sort((x, y) => x.kind.localeCompare(y.kind)),
    ).toEqual([
      { kind: 'intro_optin', askedAt: OPT_IN_ASKED },
      { kind: 'intro_proposal', askedAt: CARD_ASKED },
    ]);
  });
});
