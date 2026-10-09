import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import { decideGmail } from './signals';
import {
  commitInferredStamp,
  gmailSourceRef,
  ingestGroupProjection,
  listFamilyChildren,
  removeStamp,
} from './store';

const NOW = new Date('2026-04-15T15:00:00Z');

describe('kid interest stamps', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('writes one inferred stamp, keeps the subject off the audit row, and tombstones a removal', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Passport');
    const childId = await seedChild(db.database, familyId, 'Mia', 84, undefined, NOW);
    const integrationId = await seedIntegration(db.database, familyId, parentUserId, 'gmail');
    const children = await listFamilyChildren(db.database, familyId, NOW);
    const decision = decideGmail({
      subject: 'Registration confirmed: Little Dragons Karate, Fall session, 12 weeks',
      title: 'Little Dragons Karate',
      body: 'this body must not be stored or change the stamp',
      kind: 'booking_confirmation',
      connectedByUserId: parentUserId,
      actorUserId: parentUserId,
      teenAttributed: false,
      childRef: childId,
      children,
      now: NOW,
    });
    expect(decision.stamp).toBe(true);
    if (!decision.stamp) return;

    const sourceRef = gmailSourceRef(integrationId, 'msg-1');
    const first = await commitInferredStamp(db.database, {
      familyId,
      actor: 'system',
      sourceType: 'gmail',
      sourceRef,
      sourceOwnerUserId: parentUserId,
      subject: decision.stamp
        ? 'Registration confirmed: Little Dragons Karate, Fall session, 12 weeks'
        : null,
      seenOn: '2026-04-15',
      draft: decision.draft,
      asked: false,
      now: NOW,
    });
    expect(first.outcome).toBe('inserted');

    const again = await commitInferredStamp(db.database, {
      familyId,
      actor: 'system',
      sourceType: 'gmail',
      sourceRef,
      sourceOwnerUserId: parentUserId,
      subject: 'Registration confirmed: Little Dragons Karate, Fall session, 12 weeks',
      seenOn: '2026-04-15',
      draft: decision.draft,
      asked: false,
      now: NOW,
    });
    expect(again.outcome).toBe('updated');

    const rows = await db.database
      .select()
      .from(schema.kidInterests)
      .where(eq(schema.kidInterests.familyId, familyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceSubject).toContain('Little Dragons');
    expect(JSON.stringify(rows[0])).not.toContain('this body must not');

    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    for (const audit of audits) {
      const after = JSON.stringify(audit.after);
      expect(after).not.toContain('Little Dragons');
      expect(after).not.toContain('Mia');
      expect(after).not.toContain('Karate');
      expect(audit.after).toMatchObject({
        state: expect.any(String),
        kind: 'activity',
        sourceType: 'gmail',
      });
    }

    if (first.outcome === 'inserted') {
      await removeStamp(db.database, {
        familyId,
        actor: parentUserId,
        stampId: first.id,
        now: NOW,
      });
    }
    const blocked = await commitInferredStamp(db.database, {
      familyId,
      actor: 'system',
      sourceType: 'gmail',
      sourceRef: gmailSourceRef(integrationId, 'msg-2'),
      sourceOwnerUserId: parentUserId,
      subject: 'Registration confirmed: Little Dragons Karate, Fall session, 12 weeks',
      seenOn: '2026-04-15',
      draft: decision.draft,
      asked: false,
      now: NOW,
    });
    expect(blocked).toEqual({ outcome: 'skipped', reason: 'tombstone' });
  });

  it('does not infer a stamp for a teenager, and a group share stores no subject', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Teen');
    const childId = await seedChild(db.database, familyId, 'Ava', 160, undefined, NOW);
    const children = await listFamilyChildren(db.database, familyId, NOW);
    expect(children[0]?.teenager).toBe(true);
    const decision = decideGmail({
      subject: 'Registration confirmed: Soccer, Fall 2026, 10 weeks',
      title: 'Soccer',
      kind: 'booking_confirmation',
      connectedByUserId: parentUserId,
      actorUserId: parentUserId,
      teenAttributed: false,
      childRef: childId,
      children,
      now: NOW,
    });
    expect(decision).toMatchObject({ stamp: false, reason: 'teen' });

    const { familyId: otherFamily, parentUserId: otherParent } = await seedFamily(
      db.database,
      'Other',
    );
    const otherChild = await seedChild(db.database, otherFamily, 'Leo', 48, undefined, NOW);
    const ingested = await ingestGroupProjection(db.database, {
      familyId: otherFamily,
      childId: otherChild,
      projection: { childFirstName: 'Leo', activity: 'Farm', season: 'Fall 2025' },
      sharerFirstName: 'Priya',
      sourceRef: 'group:farm',
      now: NOW,
      ignoredSubject: 'Registration confirmed: secret subject',
    });
    expect(ingested.outcome).toBe('inserted');
    const [row] = await db.database
      .select()
      .from(schema.kidInterests)
      .where(eq(schema.kidInterests.familyId, otherFamily));
    expect(row?.sourceSubject).toBeNull();
    expect(row?.activity).toBe('Farm');
    expect(row?.sharerFirstName).toBe('Priya');
    expect(JSON.stringify(row)).not.toContain('secret subject');
    void otherParent;
  });
});
