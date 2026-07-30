import { describe, expect, it, vi } from 'vitest';
import { checkpointById, checkpointRef, parseCheckpointRef } from './checkpoints';
import {
  type HealthReplyDeps,
  handleHealthCheckpointReply,
  matchHealthReply,
} from './reply';

/**
 * VIL-243 · M8 — the reply seam. Two deterministic outcomes and nothing else: a parent
 * who says the paperwork is handled is BELIEVED and never asked again, and a parent who
 * asks for help booking gets a DRAFT they must approve. Hale never books.
 */

function db() {
  return {} as never;
}

function refFor(checkpointId: string, childId: string, occurrence = 0): string {
  const checkpoint = checkpointById(checkpointId);
  if (!checkpoint) throw new Error(`fixture drift: no checkpoint '${checkpointId}'`);
  return checkpointRef(checkpoint, childId, occurrence);
}

/** A booking checkpoint (the 18-month visit), so both reply branches are reachable. */
const REF = refFor('well_baby_18_months', 'child-1');

interface Recorded {
  done: Array<Record<string, unknown>>;
  drafts: Array<Record<string, unknown>>;
}

function harness(options: { ref?: string | null } = {}): {
  deps: HealthReplyDeps;
  recorded: Recorded;
} {
  const recorded: Recorded = { done: [], drafts: [] };
  const deps: HealthReplyDeps = {
    loadLastCheckpointRef: async () =>
      options.ref === undefined ? REF : options.ref,
    recordDone: async (_database, input) => {
      recorded.done.push(input as unknown as Record<string, unknown>);
    },
    draftCheckup: async (_database, input) => {
      recorded.drafts.push(input as unknown as Record<string, unknown>);
      return { actionId: 'action-1' };
    },
  };
  return { deps, recorded };
}

describe('matchHealthReply', () => {
  it('reads the whole done family', () => {
    for (const body of ['done', 'Done.', 'DONE!', 'did it', 'Did it.', 'finished', 'all done', '✓']) {
      expect({ body, intent: matchHealthReply(body) }).toEqual({ body, intent: 'done' });
    }
  });

  it('reads the booking-help family', () => {
    for (const body of ['yes', 'Yes please', 'book it', 'draft it']) {
      expect({ body, intent: matchHealthReply(body) }).toEqual({ body, intent: 'booking' });
    }
  });

  it('matches the whole message, never a substring', () => {
    // "not done yet" is a parent telling us the opposite. A substring match would file
    // it as done and go quiet, which is the worst possible failure for this feature.
    expect(matchHealthReply('not done yet')).toBeNull();
    expect(matchHealthReply('when is this done by?')).toBeNull();
    expect(matchHealthReply('I have not booked it')).toBeNull();
  });

  it('leaves ordinary conversation alone', () => {
    expect(matchHealthReply('what do I need for this')).toBeNull();
    expect(matchHealthReply('')).toBeNull();
  });
});

describe('handleHealthCheckpointReply', () => {
  it('records a done against the checkpoint the family was last nudged about', async () => {
    const h = harness();
    const outcome = await handleHealthCheckpointReply(
      db(),
      { familyId: 'fam-1', parentUserId: 'user-1', body: 'done' },
      h.deps,
    );

    expect(outcome).toEqual({ status: 'recorded_done', ref: REF });
    expect(h.recorded.done).toHaveLength(1);
    expect(h.recorded.done[0]).toMatchObject({
      familyId: 'fam-1',
      parentUserId: 'user-1',
      childId: 'child-1',
      checkpointId: 'well_baby_18_months',
      ref: REF,
    });
    expect(h.recorded.drafts).toHaveLength(0);
  });

  it('drafts a check-up for APPROVAL when the parent asks, and never executes', async () => {
    const h = harness();
    const outcome = await handleHealthCheckpointReply(
      db(),
      { familyId: 'fam-1', parentUserId: 'user-1', body: 'book it' },
      h.deps,
    );

    expect(outcome).toEqual({ status: 'drafted_for_approval', actionId: 'action-1' });
    expect(h.recorded.drafts).toHaveLength(1);
    expect(h.recorded.drafts[0]).toMatchObject({
      familyId: 'fam-1',
      actorUserId: 'user-1',
      childId: 'child-1',
      intentKind: 'book_checkup',
    });
    expect(h.recorded.done).toHaveLength(0);
  });

  it('refuses the booking escalation on a checkpoint that is not a visit', async () => {
    // Only a checkpoint whose TASK is booking a visit may offer to draft one. Offering
    // on a paperwork row would be Hale inventing an appointment nobody needs.
    const h = harness({ ref: refFor('school_records_ispa', 'child-1', 2026) });
    const outcome = await handleHealthCheckpointReply(
      db(),
      { familyId: 'fam-1', parentUserId: 'user-1', body: 'yes' },
      h.deps,
    );

    expect(outcome).toEqual({ status: 'ignored', reason: 'not_a_booking_checkpoint' });
    expect(h.recorded.drafts).toHaveLength(0);
  });

  it('ignores a reply when the family was never nudged about a checkpoint', async () => {
    const h = harness({ ref: null });
    const outcome = await handleHealthCheckpointReply(
      db(),
      { familyId: 'fam-1', parentUserId: 'user-1', body: 'done' },
      h.deps,
    );

    expect(outcome).toEqual({ status: 'ignored', reason: 'no_open_checkpoint' });
    expect(h.recorded.done).toHaveLength(0);
  });

  it('does not touch the checkpoint lookup for an ordinary message', async () => {
    const h = harness();
    const loadLastCheckpointRef = vi.fn(async () => REF);
    const outcome = await handleHealthCheckpointReply(
      db(),
      { familyId: 'fam-1', parentUserId: 'user-1', body: 'what is ICON' },
      { ...h.deps, loadLastCheckpointRef },
    );

    expect(outcome).toEqual({ status: 'ignored', reason: 'not_a_health_reply' });
    expect(loadLastCheckpointRef).not.toHaveBeenCalled();
  });
});

describe('checkpointRef', () => {
  const CHILD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('round-trips a per-child ref through its parser', () => {
    expect(parseCheckpointRef(refFor('immunization_6_months', CHILD))).toEqual({
      checkpointId: 'immunization_6_months',
      childId: CHILD,
      occurrence: 0,
    });
  });

  it('drops the child from a household-scoped ref, so a done covers every sibling', () => {
    expect(parseCheckpointRef(refFor('school_records_ispa', CHILD, 2026))).toEqual({
      checkpointId: 'school_records_ispa',
      childId: null,
      occurrence: 2026,
    });
  });

  it('returns null for anything that is not one', () => {
    expect(parseCheckpointRef('nonsense')).toBeNull();
    expect(parseCheckpointRef('a:b:notanumber')).toBeNull();
    expect(parseCheckpointRef('unknown_checkpoint:child:0')).toBeNull();
  });
});
