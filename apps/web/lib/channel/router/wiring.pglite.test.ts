import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_VIEW_LINK_WITHHELD } from '~/lib/signup/browser-use/live-view';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { loadInboundContext } from './wiring';

describe('loadInboundContext (VIL-613)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function inbound(body: string) {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        providerMessageId: `fixture-${familyId}`,
        body,
      })
      .returning({ id: schema.channelMessages.id });
    if (!row) throw new Error('no inbound row');
    return loadInboundContext(db.database, {
      family_id: familyId,
      parent_user_id: parentUserId,
      channel_message_id: row.id,
      provider_message_id: `fixture-${familyId}`,
      received_at: new Date('2026-11-09T12:00:00.000Z').toISOString(),
    });
  }

  it('never hands the router a live browser link the parent pasted', async () => {
    const context = await inbound('stuck here https://live.browser-use.com/s/fixture-live-token');
    expect(context?.body).toBe(`stuck here ${LIVE_VIEW_LINK_WITHHELD}`);
  });

  it('positive control: any other text reaches the router as written', async () => {
    const context = await inbound('Signed up at https://rec.example.test/swim, thanks!');
    expect(context?.body).toBe('Signed up at https://rec.example.test/swim, thanks!');
  });
});
