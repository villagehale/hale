import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';
import { composeDoorLine } from './door-line';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  process.env.JOIN_DOOR_MODEL_COPY_ENABLED = '';
  process.env.OPS_SLACK_WEBHOOK_URL = '';
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  vi.unstubAllGlobals();
});

describe('composeDoorLine', () => {
  it('calls the writer and returns the line when the flag is exactly true', async () => {
    process.env.JOIN_DOOR_MODEL_COPY_ENABLED = 'true';
    const calls: string[] = [];
    setSharedSpokenLineWriter({
      async write(request) {
        calls.push(request.purpose);
        return 'Ana added you.';
      },
    });

    const line = await composeDoorLine(db.database, {
      purpose: 'join_welcome',
      language: 'en',
      facts: { inviterName: 'Ana' },
    });

    expect(calls).toEqual(['join_welcome']);
    expect(line).toBe('Ana added you.');
  });

  it('sends nothing and pages #ops once when the writer returns nothing', async () => {
    process.env.JOIN_DOOR_MODEL_COPY_ENABLED = 'true';
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/ops';
    setSharedSpokenLineWriter({ write: async () => null });
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      posts.push(String(init?.body ?? ''));
      return new Response('ok', { status: 200 });
    });

    const welcome = await composeDoorLine(db.database, {
      purpose: 'caregiver_welcome',
      language: 'en',
      facts: { role: 'nanny' },
    });
    const again = await composeDoorLine(db.database, {
      purpose: 'join_welcome',
      language: 'en',
      facts: { inviterName: 'Ana' },
    });

    expect(welcome).toBeNull();
    expect(again).toBeNull();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('spoken_line_unwritten');
  });

  it('does not call the writer while the flag is off', async () => {
    const calls: string[] = [];
    setSharedSpokenLineWriter({
      async write(request) {
        calls.push(request.purpose);
        return 'should not send';
      },
    });

    const line = await composeDoorLine(db.database, {
      purpose: 'join_accepted_ack',
      language: 'en',
    });

    expect(line).toBeNull();
    expect(calls).toEqual([]);
  });
});
