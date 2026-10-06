import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintChannelSigninTokens } from '~/lib/auth/channel-signin';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { fakeSpokenLineBody, fakeSpokenLineComposer } from '~/lib/channel/voice/fakes';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { textFreshConnectorLink } from './fresh-link';
import { connectLineInput } from './line-input';

/**
 * A failed connect texts a new link for the provider the parent was already
 * opening. Gmail stays Gmail. The line over the link is the model's (a fake here,
 * rule #8); when it cannot be written nothing is texted and the outcome says so.
 */

const NOW = new Date('2026-09-17T15:00:00.000Z');
const PHONE = '+14165550143';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

describe('textFreshConnectorLink', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;
  let transport: FakeTransport;

  beforeEach(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    db = await createTestDb();
    const seeded = await seedFamily(db.database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    transport = new FakeTransport();
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  it('texts a Gmail link when the Gmail connect failed, and leaves the old token spent', async () => {
    const [oldLink] = await mintChannelSigninTokens(db.database, {
      userId: parentUserId,
      count: 1,
      now: NOW,
    });
    if (!oldLink) throw new Error('expected a token');

    const outcome = await textFreshConnectorLink(
      db.database,
      { familyId, parentUserId, provider: 'gmail', now: NOW },
      {
        transport,
        threadMessage: async () => 'conversation-id',
        voice: fakeSpokenLineComposer(),
      },
    );

    expect(outcome).toBe('sent');
    expect(transport.sent).toHaveLength(2);
    const body = transport.sent[0]?.body ?? '';
    const [prose, link, ...rest] = body.split('\n');
    expect(prose).toBe(
      fakeSpokenLineBody(connectLineInput({ kind: 'offer', account: 'gmail' }, 'en')),
    );
    expect(link).toContain('to=gmail');
    expect(rest).toEqual([]);
    expect(transport.sent[1]?.body).toBe(
      fakeSpokenLineBody(connectLineInput({ kind: 'google_heads_up' }, 'en')),
    );
    expect(transport.sent[1]?.body).not.toMatch(/https?:/i);
    expect(body).not.toMatch(/connect my calendar/i);
    expect(body).not.toContain('to=gcal');
    const [spent] = await db.database
      .select({ consumedAt: schema.channelSigninTokens.consumedAt })
      .from(schema.channelSigninTokens)
      .where(eq(schema.channelSigninTokens.id, oldLink.tokenId));
    expect(spent?.consumedAt).not.toBeNull();
  });

  it('texts nothing when the line cannot be written - no template under the link (voice_unsent)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await textFreshConnectorLink(
      db.database,
      { familyId, parentUserId, provider: 'gmail', now: NOW },
      {
        transport,
        threadMessage: async () => 'conversation-id',
        voice: fakeSpokenLineComposer({ fail: true }),
      },
    );

    expect(outcome).toBe('voice_unsent');
    expect(transport.sent).toHaveLength(0);
    // Nothing was claimed in the ledger either: the send never started.
    expect(await db.database.select().from(schema.channelMessages)).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
