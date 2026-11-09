import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedClaimReader as scriptedReader } from '~/lib/testing/claim-reader';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { ClaimShadowContext } from './candidate-rows';
import type { ClaimCandidateRow } from './candidates';
import { type ClaimEnforcerPorts, createClaimEnforcer } from './claim-enforce';
import { claimRowLabel } from './claim-label';
import type { ClaimReader } from './claim-reader';
import type { ClaimShadow } from './claim-shadow';
import { refuseUnbackedSend } from './gate';

/**
 * VIL-581 PR 3 · the send-boundary gate under ENFORCE. The reader is a scripted port:
 * what the model reads is the claim-read eval's job (real recordings); this pins what
 * the gate does with a reading, against the real DDL and the real reconcile view.
 */

const FAMILY = '00000000-0000-4000-8000-0000000000ab';
const NOW = new Date('2026-11-03T12:00:00Z');
const FRENCH_BOOKING = 'Votre visite chez le dentiste est réservée.';
const SELF_REFERENTIAL = "I'll stop sending the one-sec messages.";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const ready =
  (rows: ClaimCandidateRow[]): ClaimEnforcerPorts['loadContext'] =>
  async () =>
    ({ status: 'ready', rows, language: 'fr', timeZone: 'America/New_York' }) as ClaimShadowContext;

function enforcer(reader: ClaimReader, rows: ClaimCandidateRow[] = [], enforces = true) {
  return createClaimEnforcer({ enforces: () => enforces, reader, loadContext: ready(rows) });
}

function shadowSpy() {
  const calls: unknown[] = [];
  const shadow: ClaimShadow = {
    sweep: (...args) => {
      calls.push(args);
      return 'started';
    },
    coachTurn: () => 'off',
    dispatch: () => 'off',
  };
  return { shadow, calls };
}

const gate = (body: string, reader: ClaimReader, rows: ClaimCandidateRow[] = [], on = true) => {
  const spy = shadowSpy();
  return {
    spy,
    decision: refuseUnbackedSend(
      t.database,
      { familyId: FAMILY, body, now: NOW, lane: 'activity_followup' },
      spy.shadow,
      enforcer(reader, rows, on),
    ),
  };
};

describe('refuseUnbackedSend under enforce', () => {
  it('a French booking the regex cannot see is refused when the reader cites no row', async () => {
    const reader = scriptedReader(() => [{ segment: 0, kind: 'scheduled_event', row: 'none' }]);
    const { decision, spy } = gate(FRENCH_BOOKING, reader);
    expect(await decision).toEqual(['no_scheduled_row']);
    expect(reader.bodies).toEqual([FRENCH_BOOKING]);
    // Enforced: the reader decided, so no shadow read was started beside it.
    expect(spy.calls).toEqual([]);
  });

  it('the same body outside enforce is sent, unread (the language hole, positive control)', async () => {
    const reader = scriptedReader(() => [{ segment: 0, kind: 'scheduled_event', row: 'none' }]);
    const { decision, spy } = gate(FRENCH_BOOKING, reader, [], false);
    expect(await decision).toEqual([]);
    expect(reader.bodies).toEqual([]);
    expect(spy.calls).toHaveLength(1);
  });

  it('a cited calendar row backs the booking', async () => {
    const row: ClaimCandidateRow = {
      familyId: FAMILY,
      source: 'calendar',
      kind: 'scheduled_event',
      what: claimRowLabel(
        {
          from: 'calendar',
          title: 'Dentist',
          childId: null,
          childDateOfBirth: null,
          sensitive: false,
        },
        NOW,
      ),
      startsAt: new Date('2026-11-05T15:00:00Z'),
    };
    const reader = scriptedReader(() => [{ segment: 0, kind: 'scheduled_event', row: 'e1' }]);
    expect(await gate(FRENCH_BOOKING, reader, [row]).decision).toEqual([]);
  });

  it('the English floor still refuses what main refuses, whatever the reader says', async () => {
    const reader = scriptedReader(() => []);
    expect(await gate(SELF_REFERENTIAL, reader).decision).toEqual(['self_referential']);
    expect(reader.bodies).toEqual([SELF_REFERENTIAL]);
  });

  it('a read that failed is a named refusal, never a pass', async () => {
    const reader = scriptedReader(() => 'unreachable');
    expect(await gate(FRENCH_BOOKING, reader).decision).toEqual(['claim_read_failed']);
  });

  it('a mintable watch the reader cites is unsendable on a lane that cannot write it', async () => {
    const window: ClaimCandidateRow = {
      familyId: FAMILY,
      source: 'mintable_window',
      kind: 'registration_watch',
      what: claimRowLabel({ from: 'program', town: 'Riverford', domain: null, cycle: null }, NOW),
      opensForFamilyAt: new Date('2026-12-01T12:00:00Z'),
    };
    const reader = scriptedReader(() => [{ segment: 0, kind: 'registration_watch', row: 'w1' }]);
    // The view in this empty family has no window, so a mint cited against it is a bug.
    const body = 'Je vous écris avant l’ouverture des inscriptions.';
    // The view in this empty family has no window, so a mint cited against it is a bug.
    await expect(gate(body, reader, [window]).decision).rejects.toThrow(/no mintable window/);
  });
});

describe('the enforcer’s reading', () => {
  it('a cited window becomes the view window’s mint, once', async () => {
    const window: ClaimCandidateRow = {
      familyId: FAMILY,
      source: 'mintable_window',
      kind: 'registration_watch',
      what: claimRowLabel({ from: 'program', town: 'Riverford', domain: null, cycle: null }, NOW),
      opensForFamilyAt: new Date('2026-12-01T12:00:00Z'),
    };
    const reader = scriptedReader(() => [
      { segment: 0, kind: 'registration_watch', row: 'w1' },
      { segment: 1, kind: 'registration_watch', row: 'w1' },
    ]);
    const read = await enforcer(reader, [window]).read(t.database, {
      familyId: FAMILY,
      parentUserId: null,
      now: NOW,
      body: 'Je surveille les inscriptions. Je vous écris avant.',
      view: {
        openKinds: new Set(),
        pendingKinds: new Set(),
        registrationLaddered: false,
        mintableWindow: { town: 'Riverford', opensForFamilyAt: new Date('2026-12-01T12:00:00Z') },
        scheduledTitles: [],
        statedBookings: [],
      },
      signal: new AbortController().signal,
      budgetMs: 15_000,
    });
    expect(read).toMatchObject({
      status: 'read',
      mints: [
        {
          kind: 'registration_watch',
          summary: 'Riverford registration: a text before it opens.',
          dueAt: new Date('2026-12-01T12:00:00Z'),
        },
      ],
    });
    expect(read.status === 'read' && read.mints).toHaveLength(1);
  });

  it('a recipient with no zone is a named failure, and the reader is never asked', async () => {
    const reader = scriptedReader(() => []);
    const read = await createClaimEnforcer({
      enforces: () => true,
      reader,
      loadContext: async () => ({ status: 'skipped', reason: 'no_time_zone' }),
    }).read(t.database, {
      familyId: FAMILY,
      parentUserId: 'parent-p',
      now: NOW,
      body: FRENCH_BOOKING,
      view: {
        openKinds: new Set(),
        pendingKinds: new Set(),
        registrationLaddered: false,
        mintableWindow: null,
        scheduledTitles: [],
        statedBookings: [],
      },
      signal: new AbortController().signal,
      budgetMs: 15_000,
    });
    expect(read).toEqual({ status: 'failed', reason: 'no_time_zone' });
    expect(reader.bodies).toEqual([]);
  });
});
