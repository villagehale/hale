import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { rememberParentLanguage } from './locale';
import { createInboundLaneScreen } from './screen';

/**
 * The write path for the language the inbound screen read.
 *
 * The screen is handed a canned tool result — the judgement is measured in the
 * inbound-lane eval, against cached Claude, and is not re-decided here (rule #8).
 * What is proven here is the store: the tag comes back off the reading and lands
 * on `users.locale` only when it differs.
 */

const ZH_INBOUND = '这周末有亲子活动吗';
const AR_INBOUND = 'هل يوجد نشاط للأطفال هذا الأسبوع';

function clientReturning(input: unknown): () => AgentClient {
  return () =>
    ({
      messages: {
        async create() {
          return {
            content: [{ type: 'text', text: JSON.stringify(input) }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    }) as unknown as AgentClient;
}

async function localeOf(database: Database, parentUserId: string): Promise<string> {
  const [row] = await database
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  if (!row) throw new Error('localeOf: no user');
  return row.locale;
}

let db: TestDb;
let database: Database;
let parentUserId: string;

beforeAll(async () => {
  db = await createTestDb();
  database = db.database;
});

afterAll(async () => {
  await db.close();
});

describe('rememberParentLanguage', () => {
  beforeAll(async () => {
    ({ parentUserId } = await seedFamily(database));
  });

  beforeEach(() => vi.stubEnv('HALE_INBOUND_SCREEN_MODEL_MODE', ''));
  afterEach(() => vi.unstubAllEnvs());

  it('stores zh from a Chinese inbound, then ar from an Arabic one, and skips a repeat or a blank', async () => {
    expect(await localeOf(database, parentUserId)).toBe('en-CA');

    const zh = await createInboundLaneScreen(
      clientReturning({
        lane: 'in_domain',
        category: 'none',
        reason: 'family week',
        language: 'zh',
      }),
    ).read(ZH_INBOUND);
    expect(zh.language).toBe('zh');
    expect(await rememberParentLanguage(database, parentUserId, zh.language ?? '')).toEqual({
      status: 'updated',
      from: 'en-CA',
      to: 'zh',
    });
    expect(await localeOf(database, parentUserId)).toBe('zh');

    expect(await rememberParentLanguage(database, parentUserId, 'zh')).toEqual({
      status: 'unchanged',
    });
    expect(await localeOf(database, parentUserId)).toBe('zh');

    const ar = await createInboundLaneScreen(
      clientReturning({
        lane: 'in_domain',
        category: 'none',
        reason: 'family week',
        language: 'ar',
      }),
    ).read(AR_INBOUND);
    expect(ar.language).toBe('ar');
    expect(await rememberParentLanguage(database, parentUserId, ar.language ?? '')).toEqual({
      status: 'updated',
      from: 'zh',
      to: 'ar',
    });
    expect(await localeOf(database, parentUserId)).toBe('ar');

    expect(await rememberParentLanguage(database, parentUserId, '')).toEqual({ status: 'blank' });
    expect(await rememberParentLanguage(database, parentUserId, '   ')).toEqual({
      status: 'blank',
    });
    expect(await localeOf(database, parentUserId)).toBe('ar');

    expect(await rememberParentLanguage(database, parentUserId, ' zh-Hant ')).toEqual({
      status: 'updated',
      from: 'ar',
      to: 'zh-Hant',
    });
    expect(await localeOf(database, parentUserId)).toBe('zh-Hant');

    expect(await rememberParentLanguage(database, parentUserId, 'ZH')).toEqual({
      status: 'updated',
      from: 'zh-Hant',
      to: 'ZH',
    });
    expect(await localeOf(database, parentUserId)).toBe('ZH');
  });

  it('names a missing parent and a failed write, and does not log the tag', async () => {
    const missing = await rememberParentLanguage(
      database,
      '22222222-2222-4222-8222-222222222222',
      'zh',
    );
    expect(missing).toEqual({ status: 'not_written', reason: 'user_missing' });

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      select() {
        throw new Error('connection refused');
      },
    } as unknown as Database;
    await expect(rememberParentLanguage(broken, parentUserId, 'zh')).resolves.toEqual({
      status: 'not_written',
      reason: 'write_failed',
    });
    expect(JSON.stringify(log.mock.calls)).toContain('connection refused');
    expect(JSON.stringify(log.mock.calls)).not.toContain('zh');
    log.mockRestore();
  });
});
