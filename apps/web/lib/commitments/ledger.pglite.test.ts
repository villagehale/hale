import { schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { cancelCommitment, fulfillCommitment, recordCommitment } from './ledger';

/**
 * Hard rule #6 over the open-loops ledger: every promise Hale mints, keeps or voids
 * writes exactly one audit row, in the same transaction as the ledger write, and only
 * when the ledger row actually changed. Real Postgres, because "same transaction" and
 * "the partial unique index refused it" are properties of the database, not of a fake.
 */

const NOW = new Date('2026-08-11T14:00:00.000Z');
const DUE = new Date('2026-08-14T14:00:00.000Z');
const SENT_MESSAGE = 'msg-promise';
const KEEPING_MESSAGE = 'msg-kept';
/** Free text that may name a child — it must never reach `after`. */
const SUMMARY = 'Your first weekend find for Juniper lands in a day or two.';

let db: TestDb;
let familyId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('truncate table families, users cascade');
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Larkspur household', provinceOrState: 'ON', country: 'Canada' })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;
});

function commitmentAudits() {
  return db.database
    .select({
      actor: schema.auditLog.actor,
      actionTaken: schema.auditLog.actionTaken,
      targetTable: schema.auditLog.targetTable,
      targetId: schema.auditLog.targetId,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId))
    .orderBy(asc(schema.auditLog.occurredAt), asc(schema.auditLog.actionTaken));
}

function ledgerRows() {
  return db.database
    .select({
      id: schema.agentCommitments.id,
      fulfilledAt: schema.agentCommitments.fulfilledAt,
    })
    .from(schema.agentCommitments)
    .where(eq(schema.agentCommitments.familyId, familyId));
}

function recordFirstFind(channelMessageId: string | null = SENT_MESSAGE) {
  return recordCommitment(db.database, {
    familyId,
    kind: 'first_find',
    summary: SUMMARY,
    dueAt: DUE,
    channelMessageId,
  });
}

async function refuseAuditVerb(verb: string) {
  await db.exec(`
    create or replace function refuse_commitment_audit() returns trigger as $$
    begin raise exception 'audit write refused'; end;
    $$ language plpgsql;
    create trigger refuse_commitment_audit_trg before insert on audit_log
      for each row when (new.action_taken = '${verb}')
      execute function refuse_commitment_audit();
  `);
}

async function allowAuditVerbs() {
  await db.exec(`
    drop trigger if exists refuse_commitment_audit_trg on audit_log;
    drop function if exists refuse_commitment_audit();
  `);
}

describe('the ledger writes one audit row per changed promise (rule #6)', () => {
  it('records, keeps and voids promises with one row each, never carrying the summary', async () => {
    const recorded = await recordFirstFind();
    expect(recorded.status).toBe('recorded');
    const firstId = recorded.status === 'recorded' ? recorded.commitmentId : '';

    expect(await commitmentAudits()).toEqual([
      {
        actor: 'system',
        actionTaken: 'commitment_recorded',
        targetTable: 'agent_commitments',
        targetId: firstId,
        after: { kind: 'first_find', dueAt: DUE.toISOString() },
      },
    ]);

    const kept = await fulfillCommitment(db.database, {
      familyId,
      kind: 'first_find',
      channelMessageId: KEEPING_MESSAGE,
      now: NOW,
    });
    expect(kept).toEqual({ status: 'closed', commitmentIds: [firstId] });

    const watch = await recordCommitment(db.database, {
      familyId,
      kind: 'spot_watch',
      summary: 'A text the moment a spot opens.',
      dueAt: DUE,
      channelMessageId: SENT_MESSAGE,
    });
    const watchId = watch.status === 'recorded' ? watch.commitmentId : '';
    expect(watchId).not.toBe('');

    const voided = await cancelCommitment(db.database, {
      familyId,
      kind: 'spot_watch',
      reason: 'spot_watch_ended',
      now: NOW,
    });
    expect(voided).toEqual({ status: 'closed', commitmentIds: [watchId] });

    const rows = await commitmentAudits();
    expect(rows.map((row) => [row.actionTaken, row.targetId])).toEqual([
      ['commitment_recorded', firstId],
      ['commitment_fulfilled', firstId],
      ['commitment_recorded', watchId],
      ['commitment_cancelled', watchId],
    ]);
    expect(rows[1]?.after).toEqual({ kind: 'first_find', fulfilledBy: KEEPING_MESSAGE });
    expect(rows[3]?.after).toEqual({ kind: 'spot_watch', reason: 'spot_watch_ended' });
    expect(rows.every((row) => row.targetTable === 'agent_commitments')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('Juniper');
  });

  it('keeps a free-text topic out of the audit row', async () => {
    // The activity follow-up's topic is the search phrase its summary is built from.
    const subject = 'weekend pottery for Juniper';
    const recorded = await recordCommitment(db.database, {
      familyId,
      kind: 'activity_followup',
      summary: `A promise to come back with what I find on ${subject}`,
      topic: subject,
      dueAt: DUE,
      channelMessageId: SENT_MESSAGE,
    });
    expect(recorded.status).toBe('recorded');

    const rows = await commitmentAudits();
    expect(rows.map((row) => row.after)).toEqual([
      { kind: 'activity_followup', dueAt: DUE.toISOString() },
    ]);
    expect(JSON.stringify(rows)).not.toContain('pottery');
  });

  it('writes no row for a re-fired promise the index refused', async () => {
    expect((await recordFirstFind()).status).toBe('recorded');
    // Positive control: the first mint wrote its row.
    expect(await commitmentAudits()).toHaveLength(1);

    expect(await recordFirstFind('msg-refired')).toEqual({ status: 'already_open' });
    expect(await commitmentAudits()).toHaveLength(1);
  });

  it('writes no row when there was nothing open to keep', async () => {
    const keep = () =>
      fulfillCommitment(db.database, {
        familyId,
        kind: 'first_find',
        channelMessageId: KEEPING_MESSAGE,
        now: NOW,
      });

    expect(await keep()).toEqual({ status: 'none_open' });
    expect(await commitmentAudits()).toEqual([]);

    // Positive control: with one open, the same keep writes its row.
    await recordFirstFind();
    expect((await keep()).status).toBe('closed');
    expect((await commitmentAudits()).map((row) => row.actionTaken)).toEqual([
      'commitment_recorded',
      'commitment_fulfilled',
    ]);
  });

  it('writes no row for a promise whose message left no ledger row', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await recordFirstFind(null)).toEqual({
      status: 'not_recorded',
      reason: 'no_ledger_row',
    });
    expect(await commitmentAudits()).toEqual([]);
    logged.mockRestore();

    // Positive control: the same promise with its message id writes a row.
    expect((await recordFirstFind()).status).toBe('recorded');
    expect(await commitmentAudits()).toHaveLength(1);
  });
});

describe('an audit failure rolls the ledger write back', () => {
  it('leaves no promise behind when its audit row is refused', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await refuseAuditVerb('commitment_recorded');
    try {
      expect(await recordFirstFind()).toEqual({ status: 'not_recorded', reason: 'write_failed' });
      expect(await ledgerRows()).toEqual([]);
      expect(await commitmentAudits()).toEqual([]);
    } finally {
      await allowAuditVerbs();
      logged.mockRestore();
    }

    // Positive control: with the audit accepted, the same record lands one ledger row.
    expect((await recordFirstFind()).status).toBe('recorded');
    expect(await ledgerRows()).toHaveLength(1);
  });

  it('leaves the promise open when the audit row for keeping it is refused', async () => {
    await recordFirstFind();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await refuseAuditVerb('commitment_fulfilled');
    try {
      expect(
        await fulfillCommitment(db.database, {
          familyId,
          kind: 'first_find',
          channelMessageId: KEEPING_MESSAGE,
          now: NOW,
        }),
      ).toEqual({ status: 'not_closed', reason: 'write_failed' });
      const [row] = await ledgerRows();
      expect(row?.fulfilledAt).toBeNull();
      expect((await commitmentAudits()).map((audit) => audit.actionTaken)).toEqual([
        'commitment_recorded',
      ]);
    } finally {
      await allowAuditVerbs();
      logged.mockRestore();
    }
  });
});
