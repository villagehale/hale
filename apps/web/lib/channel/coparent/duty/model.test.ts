import { describe, expect, it } from 'vitest';
import {
  dutyStorage,
  needsWhichKid,
  planDutyRemoval,
  planDutyUpdate,
  priorFromLegacyWhoTakes,
  readDutyFact,
} from './model';

const A = 'parent-a';
const B = 'parent-b';

describe('duty plan', () => {
  it('keeps a vote for the other parent as a proposal until they confirm', () => {
    const proposed = planDutyUpdate(null, {
      actorUserId: A,
      slot: { role: 'attend', claim: 'other_parent', name: 'Sam', userId: B, confidence: 1 },
      eventKey: 'evt',
      kidTitle: 'Maya swim',
    });
    expect(proposed.status).toBe('proposed');
    expect(proposed.owner).toBeNull();
    expect(proposed.proposedForUserId).toBe(B);
    expect(proposed.proposedByUserId).toBe(A);

    const confirmed = planDutyUpdate(proposed, {
      actorUserId: B,
      slot: { role: 'attend', claim: 'self', name: null, userId: B, confidence: 1 },
      eventKey: 'evt',
      kidTitle: 'Maya swim',
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.owner).toEqual({ kind: 'parent', userId: B });
  });

  it('does not pick a winner when both parents say they will do it', () => {
    const first = planDutyUpdate(null, {
      actorUserId: A,
      slot: { role: 'pickup', claim: 'self', name: null, userId: A, confidence: 1 },
      eventKey: 'evt',
      kidTitle: null,
    });
    const second = planDutyUpdate(first, {
      actorUserId: B,
      slot: { role: 'pickup', claim: 'self', name: null, userId: B, confidence: 1 },
      eventKey: 'evt',
      kidTitle: null,
    });
    expect(second.status).toBe('conflict');
    expect(second.owner).toBeNull();
  });

  it('overwrites a changed claim and does not keep the old one', () => {
    const yes = planDutyUpdate(null, {
      actorUserId: A,
      slot: { role: 'attend', claim: 'self', name: null, userId: A, confidence: 1 },
      eventKey: 'evt',
      kidTitle: 'Maya swim',
    });
    const changed = planDutyUpdate(yes, {
      actorUserId: A,
      slot: { role: 'attend', claim: 'neither', name: null, userId: null, confidence: 1 },
      eventKey: 'evt',
      kidTitle: 'Maya swim',
    });
    expect(changed.status).toBe('declined');
    expect(changed.owner).toBeNull();
    expect(changed.claims.filter((row) => row.userId === A)).toEqual([
      { userId: A, claim: 'neither', targetUserId: null },
    ]);
  });

  it('allows both parents to attend', () => {
    const both = planDutyUpdate(null, {
      actorUserId: A,
      slot: { role: 'attend', claim: 'both', name: null, userId: null, confidence: 1 },
      eventKey: 'evt',
      kidTitle: 'Maya swim',
    });
    expect(both.status).toBe('confirmed');
    expect(both.owner).toEqual({ kind: 'both_parents' });
    expect(both.attendance).toBe('going');
  });

  it('stores a named non-parent and drops them when that vote is removed', () => {
    const named = planDutyUpdate(null, {
      actorUserId: A,
      slot: { role: 'pickup', claim: 'named', name: 'Grandma', userId: null, confidence: 1 },
      eventKey: 'evt',
      kidTitle: 'Maya swim',
    });
    expect(named.owner).toEqual({ kind: 'named', name: 'Grandma' });
    expect(named.status).toBe('confirmed');
    const removed = planDutyRemoval(named, A);
    expect(removed.owner).toBeNull();
    expect(removed.status).toBe('open');
  });

  it('treats a legacy who-takes taker as an attend claim so the other parent conflicts', () => {
    const prior = priorFromLegacyWhoTakes(
      {
        factKey: 'who-takes/start/maya%20swim',
        status: 'decided',
        takerUserId: A,
        kid: 'Maya',
        event: 'swim',
      },
      'attend',
    );
    const next = planDutyUpdate(prior, {
      actorUserId: B,
      slot: { role: 'attend', claim: 'self', name: null, userId: B, confidence: 1 },
      eventKey: 'evt',
      kidTitle: 'Maya swim',
    });
    expect(next.status).toBe('conflict');
    expect(next.owner).toBeNull();
  });

  it('reads a legacy who-takes fact and a duty fact', () => {
    expect(
      readDutyFact('who-takes/2026-09-25T19:00:00.000Z/maya%20swim', {
        kind: 'who_takes',
        status: 'decided',
        takerUserId: A,
        kid: 'Maya',
        event: 'swim',
      }),
    ).toMatchObject({ legacy: true, role: 'who_takes', ownerUserId: A, kidTitle: 'Maya swim' });
    expect(
      readDutyFact('duty/evt/pickup', {
        kind: 'duty',
        role: 'pickup',
        status: 'confirmed',
        attendance: 'going',
        owner: { kind: 'named', name: 'Grandma' },
        kidTitle: 'Maya swim',
        claims: [],
      }),
    ).toMatchObject({ legacy: false, role: 'pickup', ownerName: 'Grandma' });
  });

  it('asks which kid when a multi-kid title names nobody, and never stores a non-kid title', () => {
    expect(needsWhichKid('swim class', ['Maya', 'Leo'])).toBe(true);
    expect(needsWhichKid('Maya swim', ['Maya', 'Leo'])).toBe(false);
    expect(needsWhichKid('swim class', ['Maya'])).toBe(false);
    const stored = dutyStorage({
      subjectKey: 'who-takes/2026-09-25T19:00:00.000Z/team%20offsite',
      role: 'attend',
      title: 'team offsite',
      childNames: ['Maya'],
    });
    expect(stored.kidTitle).toBeNull();
    expect(stored.factKey).not.toContain('offsite');
    expect(stored.factKey).not.toContain('team');
    const kid = dutyStorage({
      subjectKey: 'who-takes/2026-09-25T19:00:00.000Z/maya%20swim',
      role: 'pickup',
      title: 'Maya swim',
      childNames: ['Maya'],
    });
    expect(kid.kidTitle).toBe('Maya swim');
    expect(decodeURIComponent(kid.factKey)).toContain('maya%20swim');
  });
});
