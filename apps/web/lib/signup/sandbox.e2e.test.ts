import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { playwrightSignupBrowser } from './browser';
import { runAuthorizedSignup } from './run';
import { recordSignupOffer } from './store';

/**
 * Local mock booking forms only: a class, a ticket, and a restaurant
 * reservation. This file must not point the browser at a municipal or
 * provider site.
 */
const NOW = new Date('2026-09-29T15:00:00.000Z');

const CLASS_FORM = `<!doctype html>
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

const TICKET_FORM = `<!doctype html>
<html><body>
<form method="POST" action="/submit">
  <p data-price-cents="1800"></p>
  <label>Your name <input name="guest_name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Showtime
    <select name="showtime" required>
      <option value="">Choose</option>
      <option value="sat-1100">Sat 11:00</option>
    </select>
  </label>
  <button type="submit">Get tickets</button>
</form>
</body></html>`;

const TICKET_REPRICED_FORM = TICKET_FORM.replace(
  'data-price-cents="1800"',
  'data-price-cents="2400"',
);

const RESERVATION_FORM = `<!doctype html>
<html><body>
<form method="POST" action="/submit">
  <label>Name <input name="reservation_name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Reservation time
    <select name="reservation_time" required>
      <option value="">Choose</option>
      <option value="fri-1900">Fri 7:00</option>
    </select>
  </label>
  <button type="submit">Reserve</button>
</form>
</body></html>`;

const TICKET_CART_DATE = `<!doctype html>
<html><body>
<form method="POST" action="/tickets-cart/date">
  <p data-price-cents="1800"></p>
  <label>Visit date
    <select name="visit_date" required>
      <option value="">Choose</option>
      <option value="2026-10-10">Sat Oct 10</option>
    </select>
  </label>
  <button type="submit">Continue</button>
</form>
</body></html>`;

const TICKET_CART_TIME = `<!doctype html>
<html><body>
<form method="POST" action="/tickets-cart/time">
  <p data-price-cents="1800"></p>
  <label>Your name <input name="guest_name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Showtime
    <select name="showtime" required>
      <option value="">Choose</option>
      <option value="sat-1100">Sat 11:00</option>
    </select>
  </label>
  <button type="submit">Continue</button>
</form>
</body></html>`;

const TICKET_CART_REVIEW = `<!doctype html>
<html><body>
<form method="POST" action="/tickets-cart/confirm">
  <p data-price-cents="1800"></p>
  <p>Sat Oct 10, 11:00</p>
  <button type="submit">Confirm tickets</button>
</form>
</body></html>`;

const WAITLIST_FORM = `<!doctype html>
<html><body>
<form method="POST" action="/submit">
  <label>Child first name <input name="child_first_name" required></label>
  <label>Class time
    <select name="session" required>
      <option value="tue-1630">Tue 4:30 waitlist</option>
    </select>
  </label>
  <button type="submit">Join waitlist</button>
</form>
</body></html>`;

const PARTY_FORM = `<!doctype html>
<html><body>
<form method="POST" action="/submit">
  <label>Name <input name="reservation_name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Party size
    <select name="party_size" required>
      <option value="">Choose</option>
      <option value="2">2</option>
      <option value="4">4</option>
    </select>
  </label>
  <label>Seating note <input name="seating_note" required></label>
  <label>Reservation time
    <select name="reservation_time" required>
      <option value="">Choose</option>
      <option value="fri-1900">Fri 7:00</option>
    </select>
  </label>
  <button type="submit">Reserve</button>
</form>
</body></html>`;

const UNEXPECTED_FORM = `<!doctype html>
<html><body>
<form method="POST" action="/submit">
  <label>Child first name <input name="child_first_name" required></label>
  <label>School <input name="school_name" required></label>
  <label>Session
    <select name="session" required>
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
    if (req.method === 'POST') {
      const body = await readBody(req);
      posts.push(body);
      const next: Record<string, string> = {
        '/tickets-cart/date': TICKET_CART_TIME,
        '/tickets-cart/time': TICKET_CART_REVIEW,
      };
      const page = next[path ?? ''];
      if (page) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(page);
        return;
      }
      if (path === '/submit' || path === '/tickets-cart/confirm') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<!doctype html><html><body><p data-signup-status="confirmed">ok</p></body></html>',
        );
        return;
      }
    }
    const pages: Record<string, string> = {
      '/class': CLASS_FORM,
      '/register': CLASS_FORM,
      '/tickets': TICKET_FORM,
      '/tickets-repriced': TICKET_REPRICED_FORM,
      '/tickets-cart': TICKET_CART_DATE,
      '/reserve': RESERVATION_FORM,
      '/party': PARTY_FORM,
      '/waitlist': WAITLIST_FORM,
      '/unexpected': UNEXPECTED_FORM,
      '/pay': PAYMENT_FORM,
    };
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pages[path ?? ''] ?? CLASS_FORM);
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

  async function offer(input: {
    path: string;
    activityKey: string;
    sessionId: string;
    sessionLabel: string;
    priceCents: number | null;
    approvedPriceCents: number | null;
    partySize?: number | null;
    seatingNote?: string | null;
    startsAt?: string;
    endsAt?: string;
  }) {
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
      activityKey: input.activityKey,
      registrationUrl: `${base}${input.path}`,
      sessions: [
        {
          id: input.sessionId,
          label: input.sessionLabel,
          startsAt: input.startsAt ?? '2026-10-06T20:30:00.000Z',
          endsAt: input.endsAt ?? '2026-10-06T21:15:00.000Z',
          full: false,
          priceCents: input.priceCents,
          partySize: input.partySize ?? null,
          seatingNote: input.seatingNote ?? null,
        },
      ],
      approvedPriceCents: input.approvedPriceCents,
      now: NOW,
    });
    expect(stored.ok).toBe(true);
    return seeded;
  }

  async function book(seeded: { familyId: string; parentUserId: string }) {
    const browser = await playwrightSignupBrowser();
    expect(browser, 'Playwright is a dev dependency of apps/web').not.toBeNull();
    return runAuthorizedSignup(
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
  }

  async function trail(familyId: string): Promise<string> {
    const rows = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    return JSON.stringify(rows);
  }

  it('signs up for a class on the local mock', async () => {
    const seeded = await offer({
      path: '/class',
      activityKey: 'soccer-class',
      sessionId: 'tue-1630',
      sessionLabel: 'Tue 4:30',
      priceCents: null,
      approvedPriceCents: null,
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('completed');
    expect(posts).toHaveLength(1);
    const body = posts[0] ?? '';
    expect(body).toContain('child_first_name=Ada');
    expect(body).toContain('session=tue-1630');
    expect(body).toContain('postal_code=M5V2T6');
    const logged = await trail(seeded.familyId);
    expect(logged).not.toContain('Ada');
    expect(logged).not.toContain('M5V2T6');
    expect(logged).not.toContain('@');
  }, 60_000);

  it('books zoo-style tickets on the local mock when the approved price matches', async () => {
    const seeded = await offer({
      path: '/tickets',
      activityKey: 'zoo-tickets',
      sessionId: 'sat-1100',
      sessionLabel: 'Sat 11:00',
      priceCents: 1800,
      approvedPriceCents: 1800,
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('completed');
    expect(posts).toHaveLength(1);
    const body = posts[0] ?? '';
    expect(body).toMatch(/guest_name=Test(?:\+|%20)Parent/);
    expect(body).toContain('showtime=sat-1100');
    expect(body).not.toContain('Ada');
    const logged = await trail(seeded.familyId);
    expect(logged).not.toContain('Ada');
    expect(logged).not.toContain('Test Parent');
    expect(logged).not.toContain('@');
  }, 60_000);

  it('does not buy tickets when the page price changed', async () => {
    const seeded = await offer({
      path: '/tickets-repriced',
      activityKey: 'zoo-tickets',
      sessionId: 'sat-1100',
      sessionLabel: 'Sat 11:00',
      priceCents: 1800,
      approvedPriceCents: 1800,
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('price_change');
    expect(posts).toHaveLength(0);
    expect(result.reply).toContain('reason=price_change');
  }, 60_000);

  it('reserves a restaurant table on the local mock without child details', async () => {
    const seeded = await offer({
      path: '/reserve',
      activityKey: 'dinner-reservation',
      sessionId: 'fri-1900',
      sessionLabel: 'Fri 7:00',
      priceCents: null,
      approvedPriceCents: null,
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('completed');
    expect(posts).toHaveLength(1);
    const body = posts[0] ?? '';
    expect(body).toMatch(/reservation_name=Test(?:\+|%20)Parent/);
    expect(body).toContain('reservation_time=fri-1900');
    expect(body).not.toContain('Ada');
    const logged = await trail(seeded.familyId);
    expect(logged).not.toContain('Ada');
    expect(logged).not.toContain('Test Parent');
    expect(logged).not.toContain('@');
  }, 60_000);

  it('walks a multi-step ticket cart for the authorized date and time', async () => {
    const seeded = await offer({
      path: '/tickets-cart',
      activityKey: 'museum-tickets',
      sessionId: 'sat-1100',
      sessionLabel: 'Sat 11:00',
      priceCents: 1800,
      approvedPriceCents: 1800,
      startsAt: '2026-10-10T15:00:00.000Z',
      endsAt: '2026-10-10T16:00:00.000Z',
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('completed');
    const posted = posts.join('\n');
    expect(posted).toContain('visit_date=2026-10-10');
    expect(posted).toContain('showtime=sat-1100');
    expect(posted).toMatch(/guest_name=Test(?:\+|%20)Parent/);
    expect(posted).not.toContain('Ada');
    const logged = await trail(seeded.familyId);
    expect(logged).not.toContain('Ada');
    expect(logged).not.toContain('Test Parent');
    expect(logged).not.toContain('@');
  }, 60_000);

  it('does not join a class waitlist', async () => {
    const seeded = await offer({
      path: '/waitlist',
      activityKey: 'soccer-class',
      sessionId: 'tue-1630',
      sessionLabel: 'Tue 4:30',
      priceCents: null,
      approvedPriceCents: null,
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('session_full');
    expect(posts).toHaveLength(0);
    expect(result.reply).toContain('reason=session_full');
  }, 60_000);

  it('reserves a party table with the authorized size and seating note', async () => {
    const seeded = await offer({
      path: '/party',
      activityKey: 'birthday-party',
      sessionId: 'fri-1900',
      sessionLabel: 'Fri 7:00',
      priceCents: null,
      approvedPriceCents: null,
      partySize: 4,
      seatingNote: 'Window',
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('completed');
    expect(posts).toHaveLength(1);
    const body = posts[0] ?? '';
    expect(body).toContain('party_size=4');
    expect(body).toContain('seating_note=Window');
    expect(body).toContain('reservation_time=fri-1900');
    expect(body).not.toContain('Ada');
    const logged = await trail(seeded.familyId);
    expect(logged).not.toContain('Window');
    expect(logged).not.toContain('Ada');
    expect(logged).not.toContain('@');
  }, 60_000);

  it('hands back when the form asks for a field the adapters do not know', async () => {
    const seeded = await offer({
      path: '/unexpected',
      activityKey: 'soccer-class',
      sessionId: 'tue-1630',
      sessionLabel: 'Tue 4:30',
      priceCents: null,
      approvedPriceCents: null,
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('unexpected_field');
    expect(posts).toHaveLength(0);
    expect(result.reply).toContain('reason=unexpected_field');
    expect(result.reply).toContain('prefilled=none');
  }, 60_000);

  it('does not submit a local form that asks for a card', async () => {
    const seeded = await offer({
      path: '/pay',
      activityKey: 'soccer-class',
      sessionId: 'tue-1630',
      sessionLabel: 'Tue 4:30',
      priceCents: null,
      approvedPriceCents: null,
    });
    const result = await book(seeded);
    expect(result.outcome).toBe('payment');
    expect(result.reply).toContain('TODO-Design');
    expect(result.reply).toContain(`${base}/pay`);
    expect(posts).toHaveLength(0);
  }, 60_000);
});
