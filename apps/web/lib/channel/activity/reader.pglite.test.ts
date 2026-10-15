import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { toSmsReply } from '~/lib/channel/coach/reply';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { ActivityQuery } from './deidentify';
import { bindActivityReader, productionActivityFamilyReader } from './reader';
import { findActivitiesTool } from './tools';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

it('keeps the London request and exact filtered page through the tool-to-SMS path', async () => {
  const { familyId, parentUserId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city: 'London', province: 'ON', country: 'Canada', areaCoarse: 'N6A' })
    .where(eq(schema.families.id, familyId));
  const url = 'https://www.lpl.ca/whats-on?audience=Kids&date=2026-10#events';
  const queries: ActivityQuery[] = [];
  const links: { title: string; url: string }[] = [];
  const tool = findActivitiesTool({
    reader: bindActivityReader(db.database, productionActivityFamilyReader()),
    finder: {
      find: async (query) => {
        queries.push(query);
        return {
          found: true,
          picks: [
            {
              name: 'STEAM Storytime',
              sourceName: 'London Public Library',
              ageFit: 'ages 2+',
              when: 'October 2026',
              price: null,
              source: 'web',
              sourceUrl: url,
              url,
            },
          ],
        };
      },
    },
    onPromise: () => {},
    onLinks: (offered) => links.push(...offered),
  });
  await invokeTool(
    tool,
    { subject: 'London Public Library storytimes', window: 'October 2026' },
    { familyId, actor: parentUserId },
    {
      writeAudit: async () => {},
      checkChildContentAccess: async () => ({ ok: true, reason: 'ok' }),
    },
  );
  expect(queries[0]).toMatchObject({
    subject: 'London Public Library storytimes',
    window: 'October 2026',
    town: 'London, Ontario, Canada',
  });
  expect(
    toSmsReply('STEAM Storytime: lpl.ca/whats-on.', {
      children: [],
      now: new Date(),
      activityLinks: links,
    }),
  ).toBe(`STEAM Storytime: ${url}.`);
});

it('reads a saved non-GTA location and then its active area without leaking a postal code', async () => {
  const { familyId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city: 'London', province: 'ON', country: 'Canada', areaCoarse: 'N6A' })
    .where(eq(schema.families.id, familyId));
  const reader = bindActivityReader(db.database, productionActivityFamilyReader());
  expect(await reader.location?.(familyId)).toBe('London, Ontario, Canada');
  await db.database
    .insert(schema.familyAreas)
    .values({ familyId, city: 'Victoria', province: 'BC', postalCode: 'V8W 1P6', isActive: true });
  expect(await reader.location?.(familyId)).toBe('Victoria, British Columbia, Canada');
  await db.database
    .update(schema.familyAreas)
    .set({ city: '42 Main Street', postalCode: null })
    .where(eq(schema.familyAreas.familyId, familyId));
  expect(await reader.location?.(familyId)).toBeNull();
});
