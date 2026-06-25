import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { POLICY_VERSION, recordConsent } from './consent';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';

/** A fake inserter that records the table + values each insert was given. */
function fakeInserter() {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const inserter = {
    insert: vi.fn((table: unknown) => ({
      values: async (values: unknown) => {
        inserts.push({ table, values });
      },
    })),
  };
  return { inserter: inserter as never, inserts };
}

describe('recordConsent', () => {
  it('inserts a consent_records row with the policy version stamped (granted)', async () => {
    const { inserter, inserts } = fakeInserter();

    await recordConsent(inserter, {
      userId: USER_ID,
      familyId: FAMILY_ID,
      consentType: 'privacy_policy',
      granted: true,
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe(schema.consentRecords);
    expect(inserts[0]?.values).toEqual({
      userId: USER_ID,
      familyId: FAMILY_ID,
      consentType: 'privacy_policy',
      granted: true,
      consentScope: null,
      policyVersion: POLICY_VERSION,
    });
  });

  it('records a withdrawal (granted=false) and a free-form scope', async () => {
    const { inserter, inserts } = fakeInserter();

    await recordConsent(inserter, {
      userId: USER_ID,
      consentType: 'integration_specific',
      granted: false,
      consentScope: 'google_calendar',
    });

    expect(inserts[0]?.values).toMatchObject({
      userId: USER_ID,
      familyId: null,
      consentType: 'integration_specific',
      granted: false,
      consentScope: 'google_calendar',
    });
  });

  it('honors an explicit policy version (back-dated record)', async () => {
    const { inserter, inserts } = fakeInserter();

    await recordConsent(inserter, {
      userId: USER_ID,
      consentType: 'terms_of_service',
      granted: true,
      policyVersion: 'January 1, 2026',
    });

    expect(inserts[0]?.values).toMatchObject({ policyVersion: 'January 1, 2026' });
  });
});
