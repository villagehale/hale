import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeTool } from '@hale/agent';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { offerSignupTool } from './offer-tool';
import { echoOfferWriter } from './test-models';

const NOW = new Date('2026-10-28T15:00:00.000Z');
const URL = 'https://harbor-rec.example/register';

describe('offer_signup coach verb', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('records an offer from chat facts the parent already wrote', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    FAMILY_CTX.familyId = seeded.familyId;
    const writer = echoOfferWriter();
    const tool = offerSignupTool({
      database: db.database,
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: NOW,
      parentWords: `Ada's rec email has parent and tot swim Tuesday 4:30 at ${URL}`,
      linksThisTurn: () => [],
      writer,
    });
    const result = (await invokeTool(
      tool,
      {
        child: 'Ada',
        source: 'chat',
        registrationUrl: URL,
        evidence: 'parent and tot swim Tuesday 4:30',
        sessions: [
          {
            id: 'tue-1630',
            label: 'Tue 4:30',
            startsAt: '2026-11-03T20:30:00.000Z',
            endsAt: '2026-11-03T21:15:00.000Z',
            full: false,
            priceCents: 4000,
          },
        ],
        approvedPriceCents: 4000,
      },
      { familyId: seeded.familyId, actor: seeded.parentUserId },
      { writeAudit: async () => {} },
    )) as { recorded: boolean; text?: string };

    expect(result.recorded).toBe(true);
    expect(result.text).toContain('Tue 4:30');
    const rows = await db.database
      .select({ status: schema.authorizedSignupOffers.status })
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
    expect(rows).toEqual([{ status: 'pending' }]);
  });

  it('refuses a URL the turn never saw', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    FAMILY_CTX.familyId = seeded.familyId;
    const tool = offerSignupTool({
      database: db.database,
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: NOW,
      parentWords: 'can you sign Ada up for swim',
      linksThisTurn: () => [],
      writer: echoOfferWriter(),
    });
    const result = (await invokeTool(
      tool,
      {
        child: 'Ada',
        source: 'email',
        registrationUrl: URL,
        evidence: 'swim',
        sessions: [
          {
            id: 'tue-1630',
            label: 'Tue 4:30',
            startsAt: '2026-11-03T20:30:00.000Z',
            endsAt: '2026-11-03T21:15:00.000Z',
            full: false,
            priceCents: 4000,
          },
        ],
        approvedPriceCents: 4000,
      },
      { familyId: seeded.familyId, actor: seeded.parentUserId },
      { writeAudit: async () => {} },
    )) as { recorded: boolean; reason?: string };
    expect(result).toEqual({ recorded: false, reason: 'url_not_this_turn' });
  });
});
