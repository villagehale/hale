import { describe, expect, it } from 'vitest';
import { type ClaimCandidateRow, type ClaimRowAlias, buildClaimCandidates } from './candidates';
import type { ReadClaim, ReadClaimKind } from './claim-reader';
import { verifyClaimRead } from './claim-verdict';
import { segmentSentences } from './sentences';

/**
 * VIL-581 · the pure verifier. Expected values are the kind-compatibility and refusal
 * tables of the PR 1 brief (§5.4), which keep main's refusal vocabulary.
 */

const FAM = 'fam-a';
const TZ = 'America/Edmonton';
const TUE_9 = new Date('2026-11-03T16:00:00Z');

const ROW = {
  e: {
    familyId: FAM,
    source: 'calendar',
    kind: 'scheduled_event',
    what: 'Swim lesson',
    startsAt: TUE_9,
  },
  s: { familyId: FAM, source: 'parent_stated', kind: 'scheduled_event', what: '18-month checkup' },
  cRegistration: {
    familyId: FAM,
    source: 'open_commitment',
    kind: 'registration_watch',
    what: 'Maple Bend swim registration',
  },
  cFollowup: {
    familyId: FAM,
    source: 'open_commitment',
    kind: 'activity_followup',
    what: 'Art classes',
  },
  g: {
    familyId: FAM,
    source: 'watched_page',
    kind: 'spot_watch',
    what: 'Saturday swim',
    host: 'register.example.org',
  },
  q: {
    familyId: FAM,
    source: 'live_sequence',
    kind: 'registration_watch',
    what: 'Riverford swim',
    opensAt: null,
  },
  w: {
    familyId: FAM,
    source: 'mintable_window',
    kind: 'registration_watch',
    what: 'Riverford winter registration',
    opensForFamilyAt: new Date('2026-12-01T15:00:00Z'),
  },
  p1: { familyId: FAM, source: 'pending', kind: 'activity_followup', what: 'Toddler activities' },
  p2: { familyId: FAM, source: 'pending', kind: 'spot_watch', what: 'Swim class page' },
} satisfies Record<string, ClaimCandidateRow>;

function verdict(
  body: string,
  claims: ReadClaim[],
  rows: ClaimCandidateRow[],
  locale: string | undefined = 'en',
) {
  const candidates = buildClaimCandidates(FAM, rows, TZ);
  const segments = segmentSentences(body, locale);
  return verifyClaimRead(
    {
      status: 'read',
      segments,
      claims,
      usage: { input: 0, output: 0 },
      latencyMs: 0,
      attempts: 1,
    },
    { candidates, locale, timeZone: TZ },
  );
}

const claim = (kind: ReadClaimKind, row: ClaimRowAlias, segment = 0): ReadClaim => ({
  segment,
  kind,
  row,
});

describe('kind compatibility (every kind × every slot)', () => {
  // One row per slot; aliases are e1 s1 c1 (registration) c2 (follow-up) g1 q1 w1 p1 p2.
  const ALL: ClaimCandidateRow[] = [
    ROW.e,
    ROW.s,
    ROW.cRegistration,
    ROW.cFollowup,
    ROW.g,
    ROW.q,
    ROW.w,
    ROW.p1,
    ROW.p2,
  ];
  const BACKS: Record<ReadClaimKind, Partial<Record<ClaimRowAlias, string>>> = {
    scheduled_event: { e1: 'backed:scheduled_row', s1: 'backed:parent_stated' },
    registration_watch: { c1: 'backed:open_commitment', q1: 'backed:live_sequence', w1: 'minted' },
    spot_watch: { g1: 'backed:open_commitment', p2: 'backed:pending_commitment' },
    activity_followup: { c2: 'backed:open_commitment', p1: 'backed:pending_commitment' },
    co_parent_invite: {},
    self_referential: {},
  };
  for (const kind of Object.keys(BACKS) as ReadClaimKind[]) {
    for (const alias of ['e1', 's1', 'c1', 'c2', 'g1', 'q1', 'w1', 'p1', 'p2'] as const) {
      const expected =
        BACKS[kind][alias] ??
        (kind === 'co_parent_invite' || kind === 'self_referential'
          ? 'refused:never_backable'
          : 'refused:kind_incompatible');
      it(`${kind} citing ${alias} → ${expected}`, () => {
        const [resolution] = verdict('Tuesday swim is on.', [claim(kind, alias)], ALL).resolutions;
        const got =
          resolution?.status === 'backed'
            ? `backed:${resolution.matchedBy}`
            : resolution?.status === 'minted'
              ? 'minted'
              : `refused:${resolution?.why}`;
        expect(got).toBe(expected);
      });
    }
  }
});

describe('the alias must be one this call offered', () => {
  it('e2 with only e1 offered is refused, alias_not_offered', () => {
    const v = verdict('Your swim is booked.', [claim('scheduled_event', 'e2')], [ROW.e]);
    expect(v.resolutions[0]).toMatchObject({
      status: 'refused',
      why: 'alias_not_offered',
      reason: 'no_scheduled_row',
    });
    expect(v.refusedSegments).toEqual([0]);
  });

  it('e1 is backed (control)', () => {
    const v = verdict('Your swim is booked.', [claim('scheduled_event', 'e1')], [ROW.e]);
    expect(v.resolutions[0]).toMatchObject({
      status: 'backed',
      alias: 'e1',
      matchedBy: 'scheduled_row',
    });
    expect(v.refusedSegments).toEqual([]);
  });
});

describe('the refusal mapping', () => {
  it('a registration watch citing none is no_registration_watch, even with spot watches', () => {
    const v = verdict(
      "I'll text you before fall registration opens.",
      [claim('registration_watch', 'none')],
      [ROW.g, ROW.p2],
    );
    expect(v.resolutions[0]).toMatchObject({ reason: 'no_registration_watch', why: 'cited_none' });
  });

  it('a spot watch citing none is spot_watch_unshaped with a page watch, else no_registration_watch', () => {
    const withPage = verdict(
      "I'll text you when a spot opens.",
      [claim('spot_watch', 'none')],
      [ROW.g],
    );
    expect(withPage.resolutions[0]).toMatchObject({ reason: 'spot_watch_unshaped' });
    const withPending = verdict(
      "I'll text you when a spot opens.",
      [claim('spot_watch', 'none')],
      [ROW.p2],
    );
    expect(withPending.resolutions[0]).toMatchObject({ reason: 'spot_watch_unshaped' });
    const without = verdict(
      "I'll text you when a spot opens.",
      [claim('spot_watch', 'none')],
      [ROW.e],
    );
    expect(without.resolutions[0]).toMatchObject({ reason: 'no_registration_watch' });
  });

  it('booking → no_scheduled_row, follow-up → no_activity_promise', () => {
    const v = verdict(
      'Your visit is booked. I will come back with finds.',
      [claim('scheduled_event', 'none', 0), claim('activity_followup', 'none', 1)],
      [],
    );
    expect(v.resolutions.map((r) => r.status === 'refused' && r.reason)).toEqual([
      'no_scheduled_row',
      'no_activity_promise',
    ]);
  });

  it('an invite citing a row is still refused, never_backable', () => {
    const v = verdict(
      "I'll send an invite to that number.",
      [claim('co_parent_invite', 'c1')],
      [ROW.cRegistration],
    );
    expect(v.resolutions[0]).toMatchObject({
      status: 'refused',
      why: 'never_backable',
      reason: 'no_coparent_invite',
    });
    const self = verdict("I'll stop sending those.", [claim('self_referential', 'none')], []);
    expect(self.resolutions[0]).toMatchObject({
      reason: 'self_referential',
      why: 'never_backable',
    });
  });
});

describe('mints', () => {
  it('w1 is minted and the window is in mints', () => {
    const v = verdict(
      "I'll text you before it opens.",
      [claim('registration_watch', 'w1')],
      [ROW.w],
    );
    expect(v.resolutions[0]).toMatchObject({ status: 'minted', alias: 'w1', window: ROW.w });
    expect(v.mints).toEqual([ROW.w]);
  });

  it('q1 is backed by the live sequence and mints nothing (control)', () => {
    const v = verdict(
      "I'll text you before it opens.",
      [claim('registration_watch', 'q1')],
      [ROW.q],
    );
    expect(v.resolutions[0]).toMatchObject({ status: 'backed', matchedBy: 'live_sequence' });
    expect(v.mints).toEqual([]);
  });
});

describe('refusedSegments', () => {
  it('a segment holding one backed and one refused claim is refused; a backed-only one is not', () => {
    const v = verdict(
      'Your swim is booked and the dentist is booked. I will come back with toddler finds.',
      [
        claim('scheduled_event', 'e1', 0),
        claim('scheduled_event', 'none', 0),
        claim('activity_followup', 'p1', 1),
      ],
      [ROW.e, ROW.p1],
    );
    expect(v.refusedSegments).toEqual([0]);
  });
});

describe('the day/time check on a cited calendar row', () => {
  it('a booking naming another weekday is refused, day_time_conflict', () => {
    const v = verdict('Thursday 3pm swim is booked.', [claim('scheduled_event', 'e1')], [ROW.e]);
    expect(v.resolutions[0]).toMatchObject({
      status: 'refused',
      why: 'day_time_conflict',
      reason: 'no_scheduled_row',
    });
  });

  it('the matching weekday and time is backed (control)', () => {
    const v = verdict('Tuesday 9:00 swim is booked.', [claim('scheduled_event', 'e1')], [ROW.e]);
    expect(v.resolutions[0]).toMatchObject({ status: 'backed' });
  });

  it('a parent-stated booking has no time and is never day-checked', () => {
    const v = verdict('Thursday 3pm checkup is booked.', [claim('scheduled_event', 's1')], [ROW.s]);
    expect(v.resolutions[0]).toMatchObject({ status: 'backed', matchedBy: 'parent_stated' });
  });
});
