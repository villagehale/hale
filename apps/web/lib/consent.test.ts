import { readFileSync } from 'node:fs';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { POLICY_VERSION, PRIVACY_VERSION, TERMS_VERSION, recordConsent } from './consent';

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

/**
 * VIL-257 · the drift gate. The two policies are dated INDEPENDENTLY on the
 * marketing site, and a consent row that names the wrong one is a PIPEDA/Law-25
 * record-accuracy defect — so each constant is bound here to the date its live page
 * actually renders. Re-dating a policy without moving its constant fails this test.
 */
function lastUpdatedOnLivePage(page: 'terms' | 'privacy'): string {
  const source = readFileSync(new URL(`../../site/app/${page}/page.tsx`, import.meta.url), 'utf8');
  const match = source.match(/lastUpdated="([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`no lastUpdated="…" found on the ${page} page — the drift gate cannot bind`);
  }
  return match[1];
}

describe('policy versions bind to the live policy pages', () => {
  it('dates the terms version exactly as the live Terms page does', () => {
    expect(TERMS_VERSION).toBe(lastUpdatedOnLivePage('terms'));
  });

  it('dates the privacy version exactly as the live Privacy page does', () => {
    expect(PRIVACY_VERSION).toBe(lastUpdatedOnLivePage('privacy'));
  });

  it('names BOTH policies on every new consent, each labelled', () => {
    expect(POLICY_VERSION).toContain(TERMS_VERSION);
    expect(POLICY_VERSION).toContain(PRIVACY_VERSION);
    expect(POLICY_VERSION).toMatch(/terms/i);
    expect(POLICY_VERSION).toMatch(/privacy/i);
  });

  it('no longer records the terms date alone — the drift this ticket fixes', () => {
    expect(POLICY_VERSION).not.toBe(TERMS_VERSION);
    expect(PRIVACY_VERSION).not.toBe(TERMS_VERSION);
  });
});
