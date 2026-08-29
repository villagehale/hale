import { schema } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { listConsentRecordsForViewer } from './consent-records';

/**
 * The Trust card's ledger read. What is pinned: the viewer sees their OWN rows and
 * never the co-parent's (rule #5), and the row shape carries no captured artifacts
 * (evidence / ip / user agent) — the co-parent's verbatim words must be structurally
 * impossible to render from this loader's output.
 */

const VIEWER = '11111111-1111-4111-8111-111111111111';
const CO_PARENT = '22222222-2222-4222-8222-222222222222';
const FAMILY = '33333333-3333-4333-8333-333333333333';

async function seed(db: ReturnType<typeof makeFakeDb>['db']) {
  await db.insert(schema.consentRecords).values([
    {
      userId: VIEWER,
      familyId: FAMILY,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'sms_weekly_plan',
      policyVersion: 'v1',
      grantedAt: new Date('2026-08-01T00:00:00Z'),
      evidence: null,
    },
    {
      userId: VIEWER,
      familyId: FAMILY,
      consentType: 'co_parent_access_grant',
      granted: true,
      consentScope: 'family_role:co_parent',
      policyVersion: 'v1',
      grantedAt: new Date('2026-08-10T00:00:00Z'),
      evidence: { verbatimReply: 'add my partner' },
    },
    {
      userId: CO_PARENT,
      familyId: FAMILY,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'sms_join_origination',
      policyVersion: 'v1',
      grantedAt: new Date('2026-08-12T00:00:00Z'),
      evidence: { verbatimReply: 'Hi (via join-abc)' },
    },
  ]);
}

describe('listConsentRecordsForViewer', () => {
  it('returns the viewer’s own rows, newest first (positive control)', async () => {
    const fake = makeFakeDb();
    await seed(fake.db);
    const records = await listConsentRecordsForViewer(fake.db, VIEWER);
    expect(records).toHaveLength(2);
    expect(records[0]?.consentType).toBe('co_parent_access_grant');
    expect(records[1]?.consentType).toBe('sms_service_messages');
  });

  it('never returns another parent’s rows', async () => {
    const fake = makeFakeDb();
    await seed(fake.db);
    const records = await listConsentRecordsForViewer(fake.db, VIEWER);
    expect(records.some((row) => row.consentScope === 'sms_join_origination')).toBe(false);
  });

  it('carries no captured artifacts — evidence, ip and user agent are unselectable', async () => {
    const fake = makeFakeDb();
    await seed(fake.db);
    const records = await listConsentRecordsForViewer(fake.db, VIEWER);
    expect(records.length).toBeGreaterThan(0); // the absence claim is not vacuous
    for (const row of records) {
      expect(row).not.toHaveProperty('evidence');
      expect(row).not.toHaveProperty('ip');
      expect(row).not.toHaveProperty('userAgent');
      expect(JSON.stringify(row)).not.toContain('add my partner');
    }
  });
});
