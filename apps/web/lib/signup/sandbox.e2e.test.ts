import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { playwrightSignupBrowser } from './browser';
import { runAuthorizedSignup } from './run';
import { recordSignupOffer } from './store';

/**
 * A local mock registration form. This file must not point the browser at a
 * municipal or provider site.
 */
const NOW = new Date('2026-09-29T15:00:00.000Z');

const REGISTER_FORM = `<!doctype html>
<html><body>
<form method="POST" action="/submit">
  <label>Child first name <input name="child_first_name" required></label>
  <label>Parent email <input name="parent_email" type="email" required></label>
  <label>Postal code <input name="postal_code" required></label>
  <label>Session
    <select name="session" required>
      <option value="">Choose</option>
      <option value="tue-1630">Tue 4:30</option>
    </select>
  </label>
  <button type="submit">Register</button>
</form>
</body></html>`;

const PAYMENT_FORM = `<!doctype html>
<html><body>
<form method="POST" action="/submit">
  <label>Child first name <input name="child_first_name" required></label>
  <label>Card <input name="card_number" autocomplete="cc-number" required></label>
  <label>Session
    <select name="session" required>
      <option value="tue-1630">Tue 4:30</option>
    </select>
  </label>
  <button type="submit">Pay and register</button>
</form>
</body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

describe('authorized signup sandbox', () => {
  let db: TestDb;
  const posts: string[] = [];
  let base = '';

  const server = createServer(async (req, res: ServerResponse) => {
    const path = req.url?.split('?')[0];
    if (req.method === 'POST' && path === '/submit') {
      posts.push(await readBody(req));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><p data-signup-status="confirmed">ok</p></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(path === '/pay' ? PAYMENT_FORM : REGISTER_FORM);
  });

  beforeAll(async () => {
    db = await createTestDb();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('sandbox server has no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await db.close();
  });

  beforeEach(() => {
    posts.length = 0;
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
  });

  async function offer(path: string) {
    const seeded = await seedFamily(db.database);
    await db.database
      .update(schema.families)
      .set({ postalCode: 'M5V2T6' })
      .where(eq(schema.families.id, seeded.familyId));
    const childId = await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    const stored = await recordSignupOffer(db.database, {
      familyId: seeded.familyId,
      childId,
      parentUserId: seeded.parentUserId,
      activityKey: 'swim-parent-tot',
      registrationUrl: `${base}${path}`,
      sessions: [
        {
          id: 'tue-1630',
          label: 'Tue 4:30',
          startsAt: '2026-10-06T20:30:00.000Z',
          endsAt: '2026-10-06T21:15:00.000Z',
          full: false,
          priceCents: null,
        },
      ],
      approvedPriceCents: null,
      now: NOW,
    });
    expect(stored.ok).toBe(true);
    return seeded;
  }

  it('fills the local mock form and submits the authorized session', async () => {
    const browser = await playwrightSignupBrowser();
    expect(browser, 'Playwright is a dev dependency of apps/web').not.toBeNull();
    const seeded = await offer('/register');
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('completed');
    expect(posts).toHaveLength(1);
    const body = posts[0] ?? '';
    expect(body).toContain('child_first_name=Ada');
    expect(body).toContain('session=tue-1630');
    expect(body).toContain('postal_code=M5V2T6');
    const rows = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, seeded.familyId));
    const trail = JSON.stringify(rows);
    expect(trail).not.toContain('Ada');
    expect(trail).not.toContain('M5V2T6');
    expect(trail).not.toContain('@');
  }, 60_000);

  it('does not submit a local form that asks for a card', async () => {
    const browser = await playwrightSignupBrowser();
    expect(browser).not.toBeNull();
    const seeded = await offer('/pay');
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('payment');
    expect(result.reply).toContain('TODO-Design');
    expect(result.reply).toContain(`${base}/pay`);
    expect(posts).toHaveLength(0);
  }, 60_000);
});
