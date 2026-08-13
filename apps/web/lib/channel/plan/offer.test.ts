import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { PlanOfferPorts } from './offer';
import { offerFullPlanTool, recordPlanOffer } from './offer';
import { PLAN_OFFER_TTL_HOURS } from './topics';

/**
 * The offer's two halves, and the one property each has to hold.
 *
 * The TOOL must not write anything — the ledger row is minted against a message that
 * does not exist yet, so all it may do is tell the turn what was offered.
 *
 * The WRITE must supersede. The partial unique index permits one open offer per
 * family, so an insert that does not clear the previous one silently locks a family
 * out of ever being offered a plan again.
 */

const FAMILY = 'fam-1';
const NOW = new Date('2026-08-12T14:00:00.000Z');
const database = {} as Database;

function ports(overrides: Partial<PlanOfferPorts> = {}) {
  const cancelled: unknown[] = [];
  const recorded: unknown[] = [];
  const base: PlanOfferPorts = {
    cancelCommitment: async (_db, input) => {
      cancelled.push(input);
      return { status: 'none_open' };
    },
    recordCommitment: async (_db, input) => {
      recorded.push(input);
      return { status: 'recorded', commitmentId: 'commitment-1' };
    },
    ...overrides,
  };
  return { ports: base, cancelled, recorded };
}

describe('offerFullPlanTool', () => {
  it('reports the offer to the turn and writes nothing', async () => {
    const offers: unknown[] = [];
    const tool = offerFullPlanTool((offer) => offers.push(offer));

    const result = await tool.handler(
      { topic: 'sleep', childId: 'child-1' },
      { familyId: FAMILY, actor: 'parent-1' },
    );

    expect(result).toEqual({ offered: true, topic: 'sleep' });
    expect(offers).toEqual([{ topic: 'sleep', childId: 'child-1' }]);
  });

  it('treats an unnamed child as a household question rather than guessing one', async () => {
    const offers: unknown[] = [];
    const tool = offerFullPlanTool((offer) => offers.push(offer));

    await tool.handler({ topic: 'tantrums' }, { familyId: FAMILY, actor: 'parent-1' });

    expect(offers).toEqual([{ topic: 'tantrums', childId: null }]);
  });

  it('is teen-gated by the guarded invoker, not by its own handler', () => {
    // A plan about a 13+ child's routine is not the parent's to be written (rule #1).
    // The refusal lives in the shared child-content guard, which only runs on tools
    // that declare they touch child content — so this flag IS the gate.
    expect(offerFullPlanTool(() => {}).touchesChildContent).toBe(true);
  });

  it('offers only topics a week of concrete instructions can be written about', () => {
    const tool = offerFullPlanTool(() => {});

    // A free-text topic would be model-authored prose selecting a proactive template
    // three days later. The schema is what makes that unexpressible.
    expect(tool.inputSchema.safeParse({ topic: 'sleep' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ topic: 'is she behind' }).success).toBe(false);
  });
});

describe('recordPlanOffer', () => {
  it('clears the previous offer before writing the new one', async () => {
    const { ports: p, cancelled, recorded } = ports();

    const outcome = await recordPlanOffer(
      database,
      { familyId: FAMILY, offer: { topic: 'solids', childId: null }, channelMessageId: 'msg-1', now: NOW },
      p,
    );

    expect(outcome).toEqual({ status: 'recorded', commitmentId: 'commitment-1' });
    expect(cancelled).toEqual([
      { familyId: FAMILY, kind: 'plan_offer', reason: 'plan_offer_superseded', now: NOW },
    ]);
    expect(recorded).toEqual([
      {
        familyId: FAMILY,
        kind: 'plan_offer',
        summary: 'Offered the full starting solids plan - waiting on a yes.',
        topic: 'solids',
        subjectChildId: null,
        dueAt: new Date(NOW.getTime() + PLAN_OFFER_TTL_HOURS * 3_600_000),
        channelMessageId: 'msg-1',
      },
    ]);
  });

  it('refuses to record an offer that never reached a transport', async () => {
    const { ports: p, cancelled, recorded } = ports();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await recordPlanOffer(
      database,
      { familyId: FAMILY, offer: { topic: 'sleep', childId: null }, channelMessageId: null, now: NOW },
      p,
    );

    // Nothing was offered, so the previous offer must also survive untouched: cancelling
    // it here would void a live offer on behalf of a message nobody received.
    expect(outcome).toEqual({ status: 'not_recorded', reason: 'no_ledger_row' });
    expect(cancelled).toEqual([]);
    expect(recorded).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('names a conflicting insert as a failure, because the YES would resolve wrong', async () => {
    const { ports: p } = ports({ recordCommitment: async () => ({ status: 'already_open' }) });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The supersede ran and the insert STILL conflicted, so an older offer is live and
    // the parent has just been offered a different plan. Their YES would send the wrong
    // one — the ledger's own benign reading of `already_open` is the wrong reading here.
    const outcome = await recordPlanOffer(
      database,
      { familyId: FAMILY, offer: { topic: 'potty', childId: null }, channelMessageId: 'msg-1', now: NOW },
      p,
    );

    expect(outcome).toEqual({ status: 'not_recorded', reason: 'already_open' });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
