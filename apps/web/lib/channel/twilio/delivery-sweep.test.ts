import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  DELIVERY_FORCE_AGE_MS,
  DELIVERY_POLL_GRACE_MS,
  DELIVERY_SWEEP_BATCH_LIMIT,
  type ProviderMessageState,
  runDeliverySweep,
  selectUnconfirmedOutbound,
} from './delivery-sweep';

/**
 * The sweep exists because delivery truth stopped re-entering the system: prod showed
 * 42 of 177 outbound SMS failed at Twilio over 30 days with ZERO failed rows in the
 * ledger, and 4 rows stuck 'queued' since Aug 28 that Twilio itself called delivered.
 * A receipt that never arrives must not mean a row that lies forever — the sweep polls
 * the provider for stale pre-terminal rows and, when nothing can confirm the send, it
 * FORCES a named terminal state rather than leaving silence (rule #11).
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');

/** Older than the poll grace, younger than the force age. */
const STALE = new Date(NOW.getTime() - DELIVERY_POLL_GRACE_MS - 60_000);
/** Past the force age: a row this old that nothing confirmed is forced terminal. */
const ANCIENT = new Date(NOW.getTime() - DELIVERY_FORCE_AGE_MS - 60_000);
/** Younger than the poll grace: a receipt may still be on its way. */
const FRESH = new Date(NOW.getTime() - 60_000);

describe('delivery-truth sweep', () => {
  let db: TestDb;
  let family: { familyId: string; parentUserId: string };

  // Booted in a hook, not the test body: pglite boot + migrations routinely
  // exceed the 5s test timeout under full parallel CI load, and hooks carry
  // their own timeout budget.
  beforeEach(async () => {
    db = await createTestDb();
    family = await seedFamily(db.database);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedOutbound(over: {
    status: 'queued' | 'sent' | 'delivered' | 'failed' | 'suppressed_cap';
    createdAt: Date;
    providerMessageId?: string | null;
    channel?: 'sms' | 'whatsapp' | 'email';
    direction?: 'in' | 'out';
  }): Promise<string> {
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: over.channel ?? 'sms',
        direction: over.direction ?? 'out',
        category: 'reply',
        providerMessageId: over.providerMessageId === undefined ? 'SM_default' : over.providerMessageId,
        status: over.status,
        sentAt: over.createdAt,
        createdAt: over.createdAt,
      })
      .returning({ id: schema.channelMessages.id });
    if (!row) throw new Error('seedOutbound: insert returned no row');
    return row.id;
  }

  async function rowState(id: string): Promise<{ status: string; errorCode: string | null }> {
    const [row] = await db.database
      .select({ status: schema.channelMessages.status, errorCode: schema.channelMessages.errorCode })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.id, id));
    if (!row) throw new Error('rowState: no row');
    return row;
  }

  async function auditRows(actionTaken: string) {
    return db.database
      .select({ targetId: schema.auditLog.targetId, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, actionTaken));
  }

  function fetchAnswering(
    answers: Record<string, ProviderMessageState>,
  ): (sid: string) => Promise<ProviderMessageState> {
    return async (sid) => {
      const answer = answers[sid];
      if (!answer) throw new Error(`unexpected poll for ${sid}`);
      return answer;
    };
  }

  function deps(answers: Record<string, ProviderMessageState>) {
    const warns: unknown[][] = [];
    return {
      warns,
      deps: {
        database: db.database,
        fetchMessageState: fetchAnswering(answers),
        now: () => NOW,
        log: {
          warn: (...args: unknown[]) => {
            warns.push(args);
          },
          error: (...args: unknown[]) => {
            warns.push(args);
          },
        },
      },
    };
  }

  describe('what the sweep may select', () => {
    it('selects stale pre-terminal outbound sms/whatsapp rows and nothing else', async () => {
      const staleQueued = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM1' });
      const staleSent = await seedOutbound({ status: 'sent', createdAt: STALE, providerMessageId: 'SM2' });
      const staleWhatsApp = await seedOutbound({
        status: 'queued',
        createdAt: STALE,
        providerMessageId: 'SM3',
        channel: 'whatsapp',
      });
      // Each of these is a reason NOT to poll: too young, already terminal, a
      // suppression (never reached a provider), an email (terminal at accept — no
      // receipt loop exists to advance it), or inbound (not ours to confirm).
      await seedOutbound({ status: 'queued', createdAt: FRESH, providerMessageId: 'SM4' });
      await seedOutbound({ status: 'delivered', createdAt: STALE, providerMessageId: 'SM5' });
      await seedOutbound({ status: 'failed', createdAt: STALE, providerMessageId: 'SM6' });
      await seedOutbound({ status: 'suppressed_cap', createdAt: STALE, providerMessageId: null });
      await seedOutbound({ status: 'sent', createdAt: STALE, providerMessageId: 'SM7', channel: 'email' });
      await seedOutbound({ status: 'delivered', createdAt: STALE, providerMessageId: 'SM8', direction: 'in' });

      const rows = await selectUnconfirmedOutbound(db.database, NOW);

      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([staleQueued, staleSent, staleWhatsApp]));
    });

    it("leaves a 'sent' row alone once it is past the force age — the carrier-without-receipts rest state", async () => {
      await seedOutbound({ status: 'sent', createdAt: ANCIENT, providerMessageId: 'SM_old_sent' });
      const queued = await seedOutbound({ status: 'queued', createdAt: ANCIENT, providerMessageId: 'SM_old_q' });

      const rows = await selectUnconfirmedOutbound(db.database, NOW);

      // The queued row stays selectable at ANY age: it is owed a forced terminal.
      expect(rows.map((r) => r.id)).toEqual([queued]);
    });

    it('is bounded per tick, oldest first', async () => {
      const ids: string[] = [];
      for (let i = 0; i < DELIVERY_SWEEP_BATCH_LIMIT + 3; i += 1) {
        ids.push(
          await seedOutbound({
            status: 'queued',
            createdAt: new Date(STALE.getTime() - (DELIVERY_SWEEP_BATCH_LIMIT + 3 - i) * 1000),
            providerMessageId: `SM_b${i}`,
          }),
        );
      }

      const rows = await selectUnconfirmedOutbound(db.database, NOW);

      expect(rows).toHaveLength(DELIVERY_SWEEP_BATCH_LIMIT);
      expect(rows[0]?.id).toBe(ids[0]);
      expect(rows.map((r) => r.id)).not.toContain(ids[ids.length - 1]);
    });
  });

  describe('reconciling provider truth', () => {
    it("writes the real terminal status for a stuck 'queued' row Twilio says was delivered — the four Aug 28 prod rows", async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM_del' });

      const h = deps({ SM_del: { ok: true, status: 'delivered', errorCode: null } });
      const summary = await runDeliverySweep(h.deps);

      expect(await rowState(id)).toEqual({ status: 'delivered', errorCode: null });
      expect(summary).toMatchObject({ scanned: 1, reconciled: 1, reconciledFailed: 0, forced: 0 });
    });

    it('writes failed + the provider error code for an undelivered send', async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM_und' });

      const h = deps({ SM_und: { ok: true, status: 'undelivered', errorCode: '30006' } });
      const summary = await runDeliverySweep(h.deps);

      expect(await rowState(id)).toEqual({ status: 'failed', errorCode: '30006' });
      expect(summary).toMatchObject({ reconciled: 1, reconciledFailed: 1, forced: 0 });
    });

    it("advances queued → sent when Twilio reports the carrier handoff, and leaves a 'sent' row Twilio still calls sent", async () => {
      const advancing = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM_adv' });
      const resting = await seedOutbound({ status: 'sent', createdAt: STALE, providerMessageId: 'SM_rest' });

      const h = deps({
        SM_adv: { ok: true, status: 'sent', errorCode: null },
        SM_rest: { ok: true, status: 'sent', errorCode: null },
      });
      const summary = await runDeliverySweep(h.deps);

      expect((await rowState(advancing)).status).toBe('sent');
      expect((await rowState(resting)).status).toBe('sent');
      expect(summary).toMatchObject({ reconciled: 1, pending: 1, forced: 0 });
    });

    it('leaves a stale row Twilio still calls queued, naming it pending — the receipt may still come', async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM_wait' });

      const h = deps({ SM_wait: { ok: true, status: 'queued', errorCode: null } });
      const summary = await runDeliverySweep(h.deps);

      expect((await rowState(id)).status).toBe('queued');
      expect(summary).toMatchObject({ pending: 1, forced: 0 });
    });

    it('leaves the row and names the outcome when the provider is unreachable (rule #11), to retry next tick', async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM_down' });

      const h = deps({ SM_down: { ok: false, reason: 'unreachable', detail: 'Twilio answered 503' } });
      const summary = await runDeliverySweep(h.deps);

      expect((await rowState(id)).status).toBe('queued');
      expect(summary).toMatchObject({ unreachable: 1, forced: 0 });
    });
  });

  describe('forcing a named terminal state', () => {
    it("forces a 'queued' row past the force age that Twilio still cannot confirm — delivery_unconfirmed, with an audit row (rule #6)", async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: ANCIENT, providerMessageId: 'SM_stuck' });

      const h = deps({ SM_stuck: { ok: true, status: 'queued', errorCode: null } });
      const summary = await runDeliverySweep(h.deps);

      expect(await rowState(id)).toEqual({ status: 'failed', errorCode: 'delivery_unconfirmed' });
      expect(summary).toMatchObject({ forced: 1, reconciled: 0 });
      const audits = await auditRows('delivery_status_forced');
      expect(audits).toEqual([
        { targetId: id, after: { status: 'failed', errorCode: 'delivery_unconfirmed' } },
      ]);
    });

    it('forces a queued row past the force age even when the provider is unreachable — not knowing is itself terminal after a day', async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: ANCIENT, providerMessageId: 'SM_dark' });

      const h = deps({ SM_dark: { ok: false, reason: 'unreachable', detail: 'fetch failed' } });
      const summary = await runDeliverySweep(h.deps);

      expect(await rowState(id)).toEqual({ status: 'failed', errorCode: 'delivery_unconfirmed' });
      expect(summary).toMatchObject({ forced: 1, unreachable: 0 });
    });

    it('forces a stale row with NO provider id — send_unconfirmed, immediately at the poll grace', async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: null });

      const h = deps({});
      const summary = await runDeliverySweep(h.deps);

      expect(await rowState(id)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(summary).toMatchObject({ forced: 1 });
      const audits = await auditRows('delivery_status_forced');
      expect(audits).toEqual([
        { targetId: id, after: { status: 'failed', errorCode: 'send_unconfirmed' } },
      ]);
    });

    it('forces a queued row whose SID the provider does not know — provider_unknown_message, at any age', async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM_gone' });

      const h = deps({ SM_gone: { ok: false, reason: 'not_found' } });
      const summary = await runDeliverySweep(h.deps);

      expect(await rowState(id)).toEqual({ status: 'failed', errorCode: 'provider_unknown_message' });
      expect(summary).toMatchObject({ forced: 1 });
    });

    it('never clobbers a live receipt that landed mid-sweep: the forced write is guarded on the observed status', async () => {
      const id = await seedOutbound({ status: 'queued', createdAt: ANCIENT, providerMessageId: 'SM_race' });

      const h = deps({});
      // The poll itself is the race window: a real delivered receipt lands after the
      // sweep read the row but before it writes.
      h.deps.fetchMessageState = async () => {
        await db.database
          .update(schema.channelMessages)
          .set({ status: 'delivered' })
          .where(eq(schema.channelMessages.id, id));
        return { ok: true, status: 'queued', errorCode: null };
      };
      const summary = await runDeliverySweep(h.deps);

      expect(await rowState(id)).toEqual({ status: 'delivered', errorCode: null });
      expect(summary).toMatchObject({ forced: 0, advancedElsewhere: 1 });
    });

    it('one broken row does not strand the rest of the batch', async () => {
      const bad = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM_throw' });
      const good = await seedOutbound({ status: 'queued', createdAt: STALE, providerMessageId: 'SM_ok' });

      const h = deps({ SM_ok: { ok: true, status: 'delivered', errorCode: null } });
      const inner = h.deps.fetchMessageState;
      h.deps.fetchMessageState = async (sid) => {
        if (sid === 'SM_throw') throw new Error('boom');
        return inner(sid);
      };
      const summary = await runDeliverySweep(h.deps);

      expect((await rowState(good)).status).toBe('delivered');
      expect((await rowState(bad)).status).toBe('queued');
      expect(summary).toMatchObject({ reconciled: 1, rowErrors: 1 });
    });
  });
});
