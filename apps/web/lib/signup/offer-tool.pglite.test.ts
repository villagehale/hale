import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
        activity: 'Parent and Tot Swim',
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

  it('a new ask tells the coach which earlier ask it closed', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    const gymUrl = 'https://gym.example-rec.test/register/tots';
    const kickersUrl = 'https://kickers.example-sport.test/register/sat';
    const offer = (url: string, activity: string, label: string, at: Date) =>
      invokeTool(
        offerSignupTool({
          database: db.database,
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          now: at,
          parentWords: `${activity} ${label} ${url}`,
          linksThisTurn: () => [],
          writer: echoOfferWriter(),
        }),
        {
          child: 'Ada',
          activity,
          source: 'chat',
          registrationUrl: url,
          evidence: `${activity} ${label}`,
          sessions: [
            {
              id: 'sat-session',
              label,
              startsAt: '2027-01-09T15:15:00.000Z',
              endsAt: '2027-01-09T16:00:00.000Z',
              full: false,
              priceCents: 12000,
            },
          ],
          approvedPriceCents: null,
        },
        { familyId: seeded.familyId, actor: seeded.parentUserId },
        { writeAudit: async () => {} },
      ) as Promise<{ recorded: boolean; closed?: unknown[] }>;

    const first = await offer(gymUrl, 'Gymnastics Tots', 'Sat 10:15', NOW);
    expect(first).toMatchObject({ recorded: true, closed: [] });
    const second = await offer(
      kickersUrl,
      'Little Kickers',
      'Sat 9:30',
      new Date(NOW.getTime() + 60_000),
    );
    expect(second).toMatchObject({
      recorded: true,
      closed: [
        { activity: 'Gymnastics Tots', host: 'gym.example-rec.test', sessions: ['Sat 10:15'] },
      ],
    });
    const rows = await db.database
      .select({
        label: schema.authorizedSignupOffers.activityLabel,
        status: schema.authorizedSignupOffers.status,
      })
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: 'Gymnastics Tots', status: 'handed_back' },
        { label: 'Little Kickers', status: 'pending' },
      ]),
    );
  });

  it('refuses a URL the turn never saw', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
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
        activity: 'Parent and Tot Swim',
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
