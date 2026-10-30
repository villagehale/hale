import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_GRANT_WINDOW_MS,
  SAFETY_ESCALATION_WINDOW_MS,
  openTeenSafetyEscalation,
  recordTeenAssent,
  requestTeenAccessGrant,
  revokeTeenAccessGrant,
} from './teen-access';

/**
 * VIL-147 · the WRITE side of rule #1's named exception. Every state change must
 * leave two records: the grant row that ENFORCES it, and an immutable audit_log row
 * (rule #6) so PIPEDA right-to-access can answer "which parent asked, when, for
 * what, and why". Consent decisions additionally append to consent_records.
 *
 * The load-bearing assertions here are the ones a reviewer cannot make by reading:
 * that a REQUEST leaves no activation window (so it unlocks nothing), that assent
 * is what opens the window, and that an escalation gets the SHORT window.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const TEEN_ID = '33333333-3333-4333-8333-333333333333';
const CONSENT_ROW_ID = '55555555-5555-4555-8555-555555555555';
const GRANT_ROW_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-08-02T12:00:00.000Z');

interface Call {
  table: unknown;
  op: 'insert' | 'update';
  values: Record<string, unknown>;
}

function stubDb(updateReturns: Record<string, unknown>[] = [{}], childDob = '2011-01-01') {
  const calls: Call[] = [];

  // requestTeenAccessGrant proves the target is a 13+ child of THIS family before it
  // writes anything, so the stub has to answer that read.
  const select = () => ({
    from: () => ({ where: () => ({ limit: async () => (childDob ? [{ dateOfBirth: childDob }] : []) }) }),
  });

  // The node is a real Promise with the builder methods hung off it, so a call the
  // store awaits directly (an insert with no .returning()) and a call it chains both
  // work without hand-rolling a thenable.
  function chain(op: 'insert' | 'update', table: unknown, rows: unknown[]) {
    const node = Object.assign(Promise.resolve(rows), {}) as Promise<unknown[]> &
      Record<string, unknown>;
    const record = (values: Record<string, unknown>) => {
      calls.push({ table, op, values });
      return node;
    };
    node.values = vi.fn(record);
    node.set = vi.fn(record);
    node.where = vi.fn(() => node);
    node.returning = vi.fn(() => Promise.resolve(rows));
    return node;
  }

  const rowsFor = (table: unknown, op: 'insert' | 'update') => {
    if (op === 'update') return updateReturns;
    if (table === schema.consentRecords) return [{ id: CONSENT_ROW_ID }];
    if (table === schema.teenAccessGrants) return [{ id: GRANT_ROW_ID }];
    return [];
  };

  const handle = {
    insert: vi.fn((table: unknown) => chain('insert', table, rowsFor(table, 'insert'))),
    update: vi.fn((table: unknown) => chain('update', table, rowsFor(table, 'update'))),
  };

  const database = {
    ...handle,
    select: vi.fn(select),
    transaction: vi.fn(async (cb: (t: typeof handle) => Promise<unknown>) => cb(handle)),
  } as unknown as Database;

  return {
    database,
    calls,
    of: (table: unknown) => calls.filter((c) => c.table === table),
    audits: () =>
      calls.filter((c) => c.table === schema.auditLog).map((c) => c.values.actionTaken as string),
  };
}

describe('requestTeenAccessGrant', () => {
  it('writes a grant with NO activation window — a request unlocks nothing', async () => {
    const s = stubDb();
    const notify = vi.fn().mockResolvedValue(null);

    const { grantId } = await requestTeenAccessGrant(
      s.database,
      {
        familyId: FAMILY_ID,
        parentUserId: PARENT_ID,
        teenChildId: TEEN_ID,
        scope: 'message_content',
        reason: 'worried about the group chat',
      },
      { notifyTeen: notify, now: NOW },
    );

    expect(grantId).toBe(GRANT_ROW_ID);

    const grant = s.of(schema.teenAccessGrants)[0]?.values;
    expect(grant).toMatchObject({
      familyId: FAMILY_ID,
      childId: TEEN_ID,
      grantedToUserId: PARENT_ID,
      scope: 'message_content',
      reason: 'worried about the group chat',
      consentRecordId: CONSENT_ROW_ID,
    });
    // The whole point: nothing that isTeenGrantActive could ever match.
    expect(grant?.startsAt).toBeUndefined();
    expect(grant?.expiresAt).toBeUndefined();
    expect(grant?.teenAssentAt).toBeUndefined();
    expect(grant?.safetyEscalation).toBeUndefined();

    // The ledger row is a REQUEST, not a grant.
    expect(s.of(schema.consentRecords)[0]?.values).toMatchObject({
      consentType: 'teen_content_access',
      granted: false,
      consentScope: 'message_content',
    });

    expect(s.audits()).toEqual([
      'teen_content_access.requested',
      'teen_content_access.teen_notified',
    ]);
  });

  it('refuses an empty reason — "explicit" means the parent said why', async () => {
    const s = stubDb();
    await expect(
      requestTeenAccessGrant(
        s.database,
        {
          familyId: FAMILY_ID,
          parentUserId: PARENT_ID,
          teenChildId: TEEN_ID,
          scope: 'message_content',
          reason: '   ',
        },
        { notifyTeen: vi.fn(), now: NOW },
      ),
    ).rejects.toThrow(/reason is required/);
    expect(s.calls).toHaveLength(0);
  });

  it('refuses a child outside the family, and a child who is not 13+', async () => {
    // The route resolves the teen today, but the STORE must not depend on that: one
    // new caller and a grant could otherwise be minted for any child id (rule #1).
    const foreign = stubDb([{}], '');
    await expect(
      requestTeenAccessGrant(
        foreign.database,
        {
          familyId: FAMILY_ID,
          parentUserId: PARENT_ID,
          teenChildId: TEEN_ID,
          scope: 'message_content',
          reason: 'worried',
        },
        { notifyTeen: vi.fn(), now: NOW },
      ),
    ).rejects.toThrow(/child not found in this family/);
    expect(foreign.calls).toHaveLength(0);

    const toddler = stubDb([{}], '2024-05-01');
    await expect(
      requestTeenAccessGrant(
        toddler.database,
        {
          familyId: FAMILY_ID,
          parentUserId: PARENT_ID,
          teenChildId: TEEN_ID,
          scope: 'message_content',
          reason: 'worried',
        },
        { notifyTeen: vi.fn(), now: NOW },
      ),
    ).rejects.toThrow(/not 13\+/);
    expect(toddler.calls).toHaveLength(0);
  });

  it('leaves the notification obligation OPEN when the teen has no channel', async () => {
    const s = stubDb();
    // The v1 reality: notifyTeen resolves null because Hale has nowhere to send.
    const notify = vi.fn().mockResolvedValue(null);

    await requestTeenAccessGrant(
      s.database,
      {
        familyId: FAMILY_ID,
        parentUserId: PARENT_ID,
        teenChildId: TEEN_ID,
        scope: 'message_content',
        reason: 'worried',
      },
      { notifyTeen: notify, now: NOW },
    );

    // teen_notified_at must NOT be stamped — the obligation stays outstanding.
    expect(s.of(schema.teenAccessGrants).some((c) => c.op === 'update')).toBe(false);
    const notifyAudit = s.calls.find(
      (c) => c.values.actionTaken === 'teen_content_access.teen_notified',
    );
    expect(notifyAudit?.values.after).toMatchObject({ delivered: false, channel: null });
  });

  it('stamps teen_notified_at only when a channel actually delivered', async () => {
    const s = stubDb();
    const notify = vi.fn().mockResolvedValue('sms');

    await requestTeenAccessGrant(
      s.database,
      {
        familyId: FAMILY_ID,
        parentUserId: PARENT_ID,
        teenChildId: TEEN_ID,
        scope: 'message_content',
        reason: 'worried',
      },
      { notifyTeen: notify, now: NOW },
    );

    const stamp = s.of(schema.teenAccessGrants).find((c) => c.op === 'update');
    expect(stamp?.values).toMatchObject({ teenNotifiedAt: NOW });
  });

  it('never puts raw content in the teen notification', async () => {
    const s = stubDb();
    const notify = vi.fn().mockResolvedValue(null);

    await requestTeenAccessGrant(
      s.database,
      {
        familyId: FAMILY_ID,
        parentUserId: PARENT_ID,
        teenChildId: TEEN_ID,
        scope: 'message_content',
        reason: 'worried',
      },
      { notifyTeen: notify, now: NOW },
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toEqual({
      teenChildId: TEEN_ID,
      grantId: GRANT_ROW_ID,
      scope: 'message_content',
      safetyEscalation: false,
    });
  });
});

describe('recordTeenAssent', () => {
  it('opens the bounded window at ASSENT, not at request time', async () => {
    const s = stubDb([
      { id: GRANT_ROW_ID, childId: TEEN_ID, scope: 'message_content', grantedToUserId: PARENT_ID },
    ]);

    const result = await recordTeenAssent(
      s.database,
      { familyId: FAMILY_ID, grantId: GRANT_ROW_ID, assentedBy: TEEN_ID },
      NOW,
    );

    expect(result).toEqual({ status: 'activated' });
    expect(s.of(schema.teenAccessGrants)[0]?.values).toMatchObject({
      teenAssentAt: NOW,
      startsAt: NOW,
      expiresAt: new Date(NOW.getTime() + MAX_GRANT_WINDOW_MS),
    });
    expect(s.of(schema.consentRecords)[0]?.values).toMatchObject({
      granted: true,
      consentScope: 'message_content',
    });
    expect(s.audits()).toEqual(['teen_content_access.assented']);
  });

  it('reports not_found when nothing was activated (already assented or revoked)', async () => {
    const s = stubDb([]);
    const result = await recordTeenAssent(
      s.database,
      { familyId: FAMILY_ID, grantId: GRANT_ROW_ID, assentedBy: TEEN_ID },
      NOW,
    );
    expect(result).toEqual({ status: 'not_found' });
    expect(s.audits()).toEqual([]);
  });
});

describe('openTeenSafetyEscalation', () => {
  it('activates immediately on the SHORT window and always notifies the teen', async () => {
    const s = stubDb();
    // A notifier that DELIVERS — the world once a teen channel exists. Until then
    // the escalation always self-closes (see the next test).
    const notify = vi.fn().mockResolvedValue('sms');

    const { expiresAt } = await openTeenSafetyEscalation(
      s.database,
      {
        familyId: FAMILY_ID,
        parentUserId: PARENT_ID,
        teenChildId: TEEN_ID,
        scope: 'message_content',
        reason: 'messages describing self-harm',
      },
      { notifyTeen: notify, now: NOW },
    );

    expect(expiresAt).toEqual(new Date(NOW.getTime() + SAFETY_ESCALATION_WINDOW_MS));
    expect(s.of(schema.teenAccessGrants)[0]?.values).toMatchObject({
      safetyEscalation: true,
      startsAt: NOW,
      expiresAt: new Date(NOW.getTime() + SAFETY_ESCALATION_WINDOW_MS),
      reason: 'messages describing self-harm',
    });
    // No teen assent is recorded — that is exactly what makes this the exception.
    expect(s.of(schema.teenAccessGrants)[0]?.values.teenAssentAt).toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ safetyEscalation: true });
    expect(s.audits()).toEqual([
      'teen_content_access.safety_escalation',
      'teen_content_access.teen_notified',
    ]);
  });

  it('closes itself when the teen could NOT be told — rule #1 conditions the exception on notice', async () => {
    // This is the one path that opens a teen's content without their agreement, and
    // rule #1 permits it only "where the teen is notified". So an escalation whose
    // notification did not land must not survive: it is revoked and the call throws,
    // leaving an audited record of an attempt rather than a silent open window.
    const s = stubDb([
      { id: GRANT_ROW_ID, childId: TEEN_ID, scope: 'message_content', grantedToUserId: PARENT_ID },
    ]);
    const notify = vi.fn().mockResolvedValue(null); // today's reality: nowhere to send

    await expect(
      openTeenSafetyEscalation(
        s.database,
        {
          familyId: FAMILY_ID,
          parentUserId: PARENT_ID,
          teenChildId: TEEN_ID,
          scope: 'message_content',
          reason: 'messages describing self-harm',
        },
        { notifyTeen: notify, now: NOW },
      ),
    ).rejects.toThrow(/could not be notified/);

    // The window is closed again, and the whole sequence is on the record.
    expect(s.of(schema.teenAccessGrants).some((c) => c.values.revokedAt === NOW)).toBe(true);
    expect(s.audits()).toEqual([
      'teen_content_access.safety_escalation',
      'teen_content_access.teen_notified',
      'teen_content_access.revoked',
    ]);
  });

  it('refuses without a typed reason', async () => {
    const s = stubDb();
    await expect(
      openTeenSafetyEscalation(
        s.database,
        {
          familyId: FAMILY_ID,
          parentUserId: PARENT_ID,
          teenChildId: TEEN_ID,
          scope: 'message_content',
          reason: '',
        },
        { notifyTeen: vi.fn(), now: NOW },
      ),
    ).rejects.toThrow(/typed reason is required/);
    expect(s.calls).toHaveLength(0);
  });
});

describe('revokeTeenAccessGrant', () => {
  it('closes the window and appends a granted=false ledger row plus its audit', async () => {
    const s = stubDb([
      { id: GRANT_ROW_ID, childId: TEEN_ID, scope: 'message_content', grantedToUserId: PARENT_ID },
    ]);

    const result = await revokeTeenAccessGrant(
      s.database,
      { familyId: FAMILY_ID, grantId: GRANT_ROW_ID, revokedBy: PARENT_ID },
      NOW,
    );

    expect(result).toEqual({ status: 'revoked' });
    expect(s.of(schema.teenAccessGrants)[0]?.values).toMatchObject({ revokedAt: NOW });
    expect(s.of(schema.consentRecords)[0]?.values).toMatchObject({
      granted: false,
      revokedAt: NOW,
      consentScope: 'message_content',
    });
    expect(s.audits()).toEqual(['teen_content_access.revoked']);
  });

  it('is idempotent — a second revoke writes nothing', async () => {
    const s = stubDb([]);
    const result = await revokeTeenAccessGrant(
      s.database,
      { familyId: FAMILY_ID, grantId: GRANT_ROW_ID, revokedBy: PARENT_ID },
      NOW,
    );
    expect(result).toEqual({ status: 'not_found' });
    expect(s.audits()).toEqual([]);
  });
});
