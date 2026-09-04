import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { claimRelayCall } from './relay-claim';

/**
 * Against a REAL Postgres, because the whole property under test is a unique index. A
 * Drizzle chain fake returns whatever rows it was handed and would report a successful
 * claim just as happily with no index at all.
 */
const AT = new Date('2026-08-19T15:00:00.000Z');

let db: TestDb;
let callCounter = 0;

function nextCallSid(): string {
  callCounter += 1;
  return `CA${String(callCounter).padStart(32, '0')}`;
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('claimRelayCall', () => {
  let ticket: { callSid: string; familyId: string; parentUserId: string };

  beforeEach(async () => {
    const family = await seedFamily(db.database);
    ticket = { callSid: nextCallSid(), ...family };
  });

  const audits = () =>
    db.database.select().from(schema.auditLog).where(eq(schema.auditLog.familyId, ticket.familyId));

  it('is won once and lost by everyone after', async () => {
    expect(await claimRelayCall(db.database, ticket, AT)).toBe(true);
    expect(await claimRelayCall(db.database, ticket, AT)).toBe(false);
    expect(await claimRelayCall(db.database, ticket, AT)).toBe(false);
  });

  it('is per CALL — another call in the same family claims freely', async () => {
    await claimRelayCall(db.database, ticket, AT);

    expect(await claimRelayCall(db.database, { ...ticket, callSid: nextCallSid() }, AT)).toBe(true);
  });

  it('leaves the refused replay on the family trail, and the won claim off it', async () => {
    await claimRelayCall(db.database, ticket, AT);
    expect(await audits()).toEqual([]);

    await claimRelayCall(db.database, ticket, AT);

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'system',
      actionTaken: 'voice_relay_ticket_replayed',
      // The row that refused the replay — the claims table's key IS the call sid,
      // so a PIPEDA traceability query can walk from this row to the winning claim.
      targetTable: 'voice_relay_claims',
      targetId: ticket.callSid,
      after: { callSid: ticket.callSid, ticketParentUserId: ticket.parentUserId },
    });
  });

  it('sweeps claims older than a day, and keeps every claim a live call could own', async () => {
    const old = { ...ticket, callSid: nextCallSid() };
    await claimRelayCall(db.database, old, new Date(AT.getTime() - 25 * 3_600_000));
    const recent = { ...ticket, callSid: nextCallSid() };
    await claimRelayCall(db.database, recent, new Date(AT.getTime() - 20 * 60_000));

    await claimRelayCall(db.database, ticket, AT);

    const rows = await db.database.select().from(schema.voiceRelayClaims);
    const sids = rows.map((r) => r.callSid);
    expect(sids).toContain(recent.callSid);
    expect(sids).toContain(ticket.callSid);
    expect(sids).not.toContain(old.callSid);
  });
});
