import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  APP_CLIP_PAY_LINK_TEMPLATE,
  APP_CLIP_PAY_TEMPLATE,
  fallbackAppClipPayOn4005,
} from './app-clip-pay';
import { sandboxCheckoutUrl } from './app-clip-sandbox';
import { setPreviewGroupCaptureSinkForTest } from './transport';

const CHAT = 'preview-chat-app-clip-ledger';
const CARD_ID = 'preview-gcapture-card-1';

describe('app clip pay 4005 ledger fallback', () => {
  let db: TestDb;
  const checkoutUrl = sandboxCheckoutUrl(`tok_test_${randomUUID()}`);

  beforeEach(async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    vi.stubEnv('PREVIEW_CAPTURE_GROUPS', 'on');
    vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', '');
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    setPreviewGroupCaptureSinkForTest({
      record: async () => {},
      chatOfMessage: async () => null,
      handlesOf: async () => null,
    });
    db = await createTestDb();
  });

  afterEach(async () => {
    setPreviewGroupCaptureSinkForTest(null);
    vi.unstubAllEnvs();
    await db.close();
  });

  async function seedCard(body: string) {
    const family = await seedFamily(db.database);
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: APP_CLIP_PAY_TEMPLATE,
      providerMessageId: CARD_ID,
      providerChatId: CHAT,
      body,
      status: 'sent',
    });
    return family;
  }

  it('sends the sandbox URL as a link and audits it', async () => {
    const family = await seedCard(checkoutUrl);
    const out = await fallbackAppClipPayOn4005(db.database, CARD_ID);
    expect(out.status).toBe('link');
    const rows = await db.database
      .select({
        templateKey: schema.channelMessages.templateKey,
        body: schema.channelMessages.body,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, family.familyId));
    expect(rows.map((row) => row.templateKey).sort()).toEqual(
      [APP_CLIP_PAY_LINK_TEMPLATE, APP_CLIP_PAY_TEMPLATE].sort(),
    );
    expect(rows.find((row) => row.templateKey === APP_CLIP_PAY_LINK_TEMPLATE)?.body).toBe(
      checkoutUrl,
    );
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, family.familyId));
    expect(audits.map((row) => row.actionTaken)).toContain('linq_app_clip_pay_link');
  });

  it('a different template sends nothing, and a dark flag does not send the link', async () => {
    const family = await seedCard(checkoutUrl);
    await db.database
      .update(schema.channelMessages)
      .set({ templateKey: 'linq:link_preview' })
      .where(eq(schema.channelMessages.familyId, family.familyId));
    expect(await fallbackAppClipPayOn4005(db.database, CARD_ID)).toEqual({
      status: 'not_sent',
      reason: 'not_app_clip',
    });
    await db.database
      .update(schema.channelMessages)
      .set({ templateKey: APP_CLIP_PAY_TEMPLATE })
      .where(eq(schema.channelMessages.familyId, family.familyId));
    vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', '');
    expect(await fallbackAppClipPayOn4005(db.database, CARD_ID)).toEqual({
      status: 'not_sent',
      reason: 'dark',
    });
  });

  it('a non-sandbox URL sends nothing', async () => {
    await seedCard('https://zero.linqapp.com/pay/acme?session=tok_live');
    const out = await fallbackAppClipPayOn4005(db.database, CARD_ID);
    expect(out).toEqual({ status: 'not_sent', reason: 'no_url' });
    const links = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, APP_CLIP_PAY_LINK_TEMPLATE));
    expect(links).toEqual([]);
  });
});
