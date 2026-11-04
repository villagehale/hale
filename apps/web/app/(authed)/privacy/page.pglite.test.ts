import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * /privacy over the real DDL, seated as each viewer. "What Hale did" is family-wide
 * (recipients, subjects, calendar titles) and the connection list names accounts, so
 * only the household's parents see either. A caregiver gets only what their seat
 * allows. Only the session is faked: which user and family the request is for.
 *
 * The parent's zone is Vancouver with the en-CA column default: 15:30Z in June (PDT,
 * UTC−7) reads 8:30 a.m.
 */

const session = vi.hoisted(() => ({ familyId: '', userId: '' }));

// lib/family imports Auth.js; the session itself is faked below, so auth() never runs.
vi.mock('~/auth', () => ({ auth: async () => null }));
vi.mock('~/lib/db', () => ({ db: () => harness.db.database }));
vi.mock('~/lib/family', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/family')>()),
  currentFamilyId: async () => session.familyId,
  currentUserId: async () => session.userId,
}));

const harness = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
const PINNED_NOW = new Date('2026-07-01T12:00:00Z');

let fam: SeededFamily;
let caregiverUserId: string;

beforeAll(async () => {
  harness.db = await createTestDb();
  vi.useFakeTimers({ now: PINNED_NOW, toFake: ['Date'] });
  vi.stubEnv('DATABASE_URL', 'postgres://pglite.test/hale');
  const database = harness.db.database;
  fam = await seedFamily(database, 'Fixture Family');
  await database
    .update(schema.users)
    .set({ timezone: 'America/Vancouver' })
    .where(eq(schema.users.id, fam.parentUserId));

  const [caregiver] = await database
    .insert(schema.users)
    .values({ email: 'sitter@example.test', name: 'Sitter Person' })
    .returning({ id: schema.users.id });
  if (!caregiver) throw new Error('fixture: no caregiver');
  caregiverUserId = caregiver.id;
  await database
    .insert(schema.familyMembers)
    .values({ familyId: fam.familyId, userId: caregiverUserId, role: 'nanny' });

  await database.insert(schema.integrations).values({
    familyId: fam.familyId,
    userId: fam.parentUserId,
    provider: 'gmail',
    status: 'active',
  });

  const [event] = await database
    .insert(schema.events)
    .values({
      familyId: fam.familyId,
      source: 'test',
      eventType: 'signal.test',
      dedupHash: 'privacy-page-email',
      status: 'actioned',
      contentProvenance: 'hale_authored',
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('fixture: no event');
  await database.insert(schema.actions).values({
    familyId: fam.familyId,
    eventId: event.id,
    actionType: 'send_email',
    payload: { to: 'coach@example.test', subject: 'Practice moved' },
    reviewerVerdict: 'approved',
    draftedAt: new Date('2026-06-19T15:00:00Z'),
    userVisibleState: 'autonomous',
    executedAt: new Date('2026-06-19T15:30:00Z'),
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await harness.db.close();
});

async function renderAs(userId: string): Promise<string> {
  session.familyId = fam.familyId;
  session.userId = userId;
  const { default: PrivacyPage } = await import('./page');
  return renderToStaticMarkup(await PrivacyPage());
}

const FAMILY_WIDE = ['>What Hale did<', 'coach@example.test', 'Practice moved', 'Your connections'];

describe('/privacy by seat', () => {
  it('shows the parent what Hale did and their connections (the positive control)', async () => {
    const html = await renderAs(fam.parentUserId);
    for (const present of FAMILY_WIDE) expect(html).toContain(present);
    expect(html).toContain('Emailed coach@example.test about Practice moved');
    expect(html).toContain('Sent Jun 19, 8:30 a.m.');
    expect(html).toContain('Gmail');
    expect(html).toContain('>Connected<');
    expect(html).toContain('Delete your account');
    expect(html).toContain('Export your data');
  });

  it('shows a caregiver none of the family’s mail, calendar, connections or export', async () => {
    const html = await renderAs(caregiverUserId);
    // The export is the family's whole record (audit trail, members, children).
    for (const absent of [
      ...FAMILY_WIDE,
      'Gmail',
      'Google Calendar',
      'Delete account',
      'Export your data',
      '>Your data<',
    ]) {
      expect(html).not.toContain(absent);
    }
    expect(html).toContain('You help out with this family. Its parents manage the family’s data.');
  });
});
