import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { introAskDedupeKey, introCardDedupeKey } from './run';

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
/** When a ledger row was written. Never the ask time: a row is written before the
 * provider has said anything about delivery. */
const ROW_WRITTEN = new Date('2026-08-20T07:00:00.000Z');

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

type SendStatus = 'queued' | 'sent' | 'delivered' | 'failed';

async function seedAsk(
  family: { familyId: string; parentUserId: string },
  dedupeKey: string,
  status: SendStatus,
  sentAt: Date,
): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'village_intro',
    status,
    dedupeKey,
    sentAt,
    createdAt: ROW_WRITTEN,
  });
}

/** A live card for `asked` and `other`. The proposal's own per-side ask stamps are set to
 * NOW on purpose: the reader must date the card off the delivered ledger row, not them. */
async function seedCard(
  asked: { familyId: string },
  other: { familyId: string },
): Promise<{ proposalId: string; askedSide: 'a' | 'b'; otherSide: 'a' | 'b' }> {
  const askedIsA = asked.familyId < other.familyId;
  const [row] = await db.database
    .insert(schema.villageIntroProposals)
    .values({
      fsa: 'A1A',
      status: 'proposed',
      stage: 'toddler',
      familyAId: askedIsA ? asked.familyId : other.familyId,
      familyBId: askedIsA ? other.familyId : asked.familyId,
      familyAAskedAt: NOW,
      familyBAskedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: schema.villageIntroProposals.id });
  return {
    proposalId: row?.id as string,
    askedSide: askedIsA ? 'a' : 'b',
    otherSide: askedIsA ? 'b' : 'a',
  };
}

async function introAsks(family: { familyId: string; parentUserId: string }) {
  const questions = await defaultOpenQuestionReader().open(db.database, { ...family, now: NOW });
  return questions
    .filter((q) => q.kind === 'intro_optin' || q.kind === 'intro_proposal')
    .map((q) => ({ kind: q.kind, askedAt: q.askedAt }))
    .sort((x, y) => x.kind.localeCompare(y.kind));
}

describe('the intro asks, through the production reader', () => {
  it('dates both asks by when the delivered message was sent, on this family side', async () => {
    const asked = await seedFamily('a');
    const other = await seedFamily('b');
    await seedAsk(asked, introAskDedupeKey(asked.familyId), 'sent', OPT_IN_ASKED);
    const card = await seedCard(asked, other);
    await seedAsk(
      asked,
      introCardDedupeKey(card.proposalId, card.askedSide),
      'delivered',
      CARD_ASKED,
    );
    // The other side's card went out at a different time; it must not leak into this side.
    await seedAsk(other, introCardDedupeKey(card.proposalId, card.otherSide), 'delivered', NOW);

    expect(await introAsks(asked)).toEqual([
      { kind: 'intro_optin', askedAt: OPT_IN_ASKED },
      { kind: 'intro_proposal', askedAt: CARD_ASKED },
    ]);
  });

  it.each(['failed', 'queued'] as const)('does not count a %s message as asked', async (status) => {
    const asked = await seedFamily('a');
    const other = await seedFamily('b');
    await seedAsk(asked, introAskDedupeKey(asked.familyId), status, OPT_IN_ASKED);
    const card = await seedCard(asked, other);
    await seedAsk(asked, introCardDedupeKey(card.proposalId, card.askedSide), status, CARD_ASKED);

    expect(await introAsks(asked)).toEqual([]);
  });
});
