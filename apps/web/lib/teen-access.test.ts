import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { GRANT_WINDOW_MS, requestTeenContentAccess } from './teen-access';

/**
 * Policy 4 (rule #1 named exception): a parent's request to see a 13+ teen's
 * redacted content is an EXPLICIT, LOGGED, TIME-LIMITED grant REQUEST that notifies
 * the teen. The writer must, in ONE transaction:
 *   1. insert a consent_records row of type teen_content_access, granted=false
 *      (a REQUEST, not yet a grant), scoped to the action, with an expiry; and
 *   2. write an immutable audit_log row (rule #6) targeting that consent row.
 * A stub teen notification is dispatched. The consume side is a follow-up.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const TEEN_ID = '33333333-3333-4333-8333-333333333333';
const ACTION_ID = '44444444-4444-4444-8444-444444444444';
const CONSENT_ROW_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-07-03T12:00:00.000Z');

function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['values', 'where', 'from', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function stubTxDb() {
  const tableName = (table: unknown): string => {
    if (table === schema.consentRecords) return 'consent_records';
    if (table === schema.auditLog) return 'audit_log';
    return 'other';
  };
  const inserted: string[] = [];
  const tx = {
    insert: vi.fn((table: unknown) => {
      inserted.push(tableName(table));
      return builder(table === schema.consentRecords ? [{ id: CONSENT_ROW_ID }] : []);
    }),
  };
  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as Database;
  return { database, inserted: () => inserted, txInsert: () => tx.insert };
}

function valuesFor(s: ReturnType<typeof stubTxDb>, table: unknown): Record<string, unknown> {
  const idx = s.txInsert().mock.calls.findIndex((c) => c[0] === table);
  const chain = s.txInsert().mock.results[idx]?.value as { values: ReturnType<typeof vi.fn> };
  return chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('requestTeenContentAccess', () => {
  it('writes a time-limited teen_content_access REQUEST and its audit row in one transaction', async () => {
    const s = stubTxDb();
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await requestTeenContentAccess(
      s.database,
      { familyId: FAMILY_ID, parentUserId: PARENT_ID, teenChildId: TEEN_ID, actionId: ACTION_ID },
      { notifyTeen: notify, now: NOW },
    );

    expect(result.consentId).toBe(CONSENT_ROW_ID);

    // Both writes happen; the consent row is written before its audit row.
    expect(s.inserted()).toEqual(['consent_records', 'audit_log']);

    // The consent is a REQUEST (not yet granted), scoped to the action, expiring.
    const consent = valuesFor(s, schema.consentRecords);
    expect(consent).toMatchObject({
      userId: PARENT_ID,
      familyId: FAMILY_ID,
      consentType: 'teen_content_access',
      granted: false,
      consentScope: ACTION_ID,
    });
    expect(consent.expiresAt).toEqual(new Date(NOW.getTime() + GRANT_WINDOW_MS));

    // Rule #6: an immutable audit row targets the consent row, actor = the parent.
    expect(valuesFor(s, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: PARENT_ID,
      actionTaken: 'teen_content_access.requested',
      targetTable: 'consent_records',
      targetId: CONSENT_ROW_ID,
    });
  });

  it('notifies the teen (named exception) with no raw content in the message', async () => {
    const s = stubTxDb();
    const notify = vi.fn().mockResolvedValue(undefined);

    await requestTeenContentAccess(
      s.database,
      { familyId: FAMILY_ID, parentUserId: PARENT_ID, teenChildId: TEEN_ID, actionId: ACTION_ID },
      { notifyTeen: notify, now: NOW },
    );

    expect(notify).toHaveBeenCalledTimes(1);
    const arg = notify.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ teenChildId: TEEN_ID, consentId: CONSENT_ROW_ID });
  });
});
