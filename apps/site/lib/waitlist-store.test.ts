import { describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/waitlist/route.js';
import { createWaitlistStore, type WaitlistDb } from './waitlist-store.js';

// An injected fake db so the store is tested without a live Postgres connection.
// `seen` mirrors the unique-email constraint: a second insert of the same email
// dedupes (created: false), matching `on conflict (email) do nothing`.
function fakeDb() {
  const seen = new Set<string>();
  const insertEmail = vi.fn(async (email: string) => {
    const created = !seen.has(email);
    seen.add(email);
    return { created };
  });
  return { db: { insertEmail } satisfies WaitlistDb, insertEmail };
}

describe('createWaitlistStore', () => {
  it('inserts the email it is given', async () => {
    const { db, insertEmail } = fakeDb();

    const result = await createWaitlistStore(db).add('alice@example.com');

    expect(insertEmail).toHaveBeenCalledWith('alice@example.com');
    expect(result).toEqual({ created: true });
  });

  it('reports created: false for a duplicate email (dedup path)', async () => {
    const { db } = fakeDb();
    const store = createWaitlistStore(db);

    await store.add('dup@example.com');
    const second = await store.add('dup@example.com');

    expect(second).toEqual({ created: false });
  });
});

function postWith(body: unknown): Request {
  return new Request('http://localhost/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/waitlist', () => {
  it('rejects an invalid email with 400 before touching the store', async () => {
    const res = await POST(postWith({ email: 'not-an-email' }));

    expect(res.status).toBe(400);
  });
});
