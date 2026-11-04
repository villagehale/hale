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
 *
 * An email leaves from the approving parent's own Gmail, and the approval row names
 * that parent. What one parent sent through their own connection stays with them: the
 * other parent sees the bare receipt and its time, never the recipient or subject.
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
let coParentUserId: string;

/** An email Hale sent; `approvedBy` is the parent whose approval (and Gmail) sent it. */
async function sentEmail(
  key: string,
  payload: { to: string; subject: string },
  executedAt: string,
  approvedBy: string | null,
) {
  const database = harness.db.database;
  const sentAt = new Date(executedAt);
  const [event] = await database
    .insert(schema.events)
    .values({
      familyId: fam.familyId,
      source: 'test',
      eventType: 'signal.test',
      dedupHash: `privacy-page-${key}`,
      status: 'actioned',
      contentProvenance: 'hale_authored',
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error(`fixture: no event for ${key}`);
  const [action] = await database
    .insert(schema.actions)
    .values({
      familyId: fam.familyId,
      eventId: event.id,
      actionType: 'send_email',
      payload,
      reviewerVerdict: 'approved',
      draftedAt: new Date(sentAt.getTime() - 30 * 60_000),
      userVisibleState: 'autonomous',
      executedAt: sentAt,
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error(`fixture: no action for ${key}`);
  if (approvedBy === null) return;
  await database.insert(schema.auditLog).values({
    familyId: fam.familyId,
    actor: approvedBy,
    actionTaken: 'action.approved_by_human',
    targetTable: 'actions',
    targetId: action.id,
    occurredAt: new Date(sentAt.getTime() - 60_000),
  });
}

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

  const [coParent] = await database
    .insert(schema.users)
    .values({ email: 'second-parent@example.test', name: 'Second Parent' })
    .returning({ id: schema.users.id });
  if (!coParent) throw new Error('fixture: no co-parent');
  coParentUserId = coParent.id;
  await database
    .insert(schema.familyMembers)
    .values({ familyId: fam.familyId, userId: coParentUserId, role: 'co_parent' });

  await sentEmail(
    'from-primary',
    { to: 'coach@example.test', subject: 'Practice moved' },
    '2026-06-19T15:30:00Z',
    fam.parentUserId,
  );
  await sentEmail(
    'from-co-parent',
    { to: 'office@example.test', subject: 'Pickup changed' },
    '2026-06-18T15:30:00Z',
    coParentUserId,
  );
  await sentEmail(
    'no-approver',
    { to: 'unnamed@example.test', subject: 'Nobody approved' },
    '2026-06-17T15:30:00Z',
    null,
  );
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

  // R7: what one parent does through their own connector stays with that parent.
  it('shows the other parent a bare receipt for an email sent from the first parent’s Gmail', async () => {
    const html = await renderAs(coParentUserId);
    expect(html).toContain('>What Hale did<');
    expect(html).toContain('Sent an email');
    expect(html).toContain('Sent Jun 19, 8:30 a.m.');
    expect(html).not.toContain('coach@example.test');
    expect(html).not.toContain('Practice moved');
    // The positive control in the same render: the co-parent's own email reads in full.
    expect(html).toContain('Emailed office@example.test about Pickup changed');
  });

  it('shows the sending parent their own email in full and the other parent’s as bare', async () => {
    const html = await renderAs(fam.parentUserId);
    expect(html).toContain('Emailed coach@example.test about Practice moved');
    expect(html).not.toContain('office@example.test');
    expect(html).not.toContain('Pickup changed');
    expect(html).toContain('Sent Jun 18, 8:30 a.m.');
  });

  // No approval row names a sender, so no parent can be shown as its sender.
  it('fails closed to the bare receipt when no sender is recorded', async () => {
    for (const viewer of [fam.parentUserId, coParentUserId]) {
      const html = await renderAs(viewer);
      expect(html).toContain('Sent Jun 17, 8:30 a.m.');
      expect(html).not.toContain('unnamed@example.test');
      expect(html).not.toContain('Nobody approved');
    }
  });
});
