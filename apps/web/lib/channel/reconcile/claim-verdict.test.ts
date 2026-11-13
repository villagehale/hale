import { describe, expect, it } from 'vitest';
import { type ClaimCandidateRow, type ClaimRowAlias, buildClaimCandidates } from './candidates';
import { claimRowLabel } from './claim-label';
import type { ReadClaim, ReadClaimKind } from './claim-reader';
import { verifyClaimRead } from './claim-verdict';
import { segmentSentences } from './sentences';

/**
 * VIL-581 · the pure verifier. Expected values are the kind-compatibility and refusal
 * tables of the PR 1 brief (§5.4), which keep main's refusal vocabulary.
 */

const FAM = 'fam-a';
const TZ = 'America/Denver';
const TUE_9 = new Date('2026-11-03T16:00:00Z');
const label = (text: string) => claimRowLabel({ from: 'pending', text }, TUE_9);

const ROW = {
  e: {
    familyId: FAM,
    source: 'calendar',
    kind: 'scheduled_event',
    what: label('Swim lesson'),
    startsAt: TUE_9,
  },
  s: {
    familyId: FAM,
    source: 'parent_stated',
    kind: 'scheduled_event',
    what: label('18-month checkup'),
  },
  cRegistration: {
    familyId: FAM,
    source: 'open_commitment',
    kind: 'registration_watch',
    what: label('Maple Bend swim registration'),
  },
  cFollowup: {
    familyId: FAM,
    source: 'open_commitment',
    kind: 'activity_followup',
    what: label('Art classes'),
  },
  g: {
    familyId: FAM,
    source: 'watched_page',
    kind: 'spot_watch',
    what: label('Saturday swim'),
    host: 'register.example.org',
  },
  q: {
    familyId: FAM,
    source: 'live_sequence',
    kind: 'registration_watch',
    what: label('Riverford swim'),
    opensAt: null,
  },
  w: {
    familyId: FAM,
    source: 'mintable_window',
    kind: 'registration_watch',
    what: label('Riverford winter registration'),
    opensForFamilyAt: new Date('2026-12-01T15:00:00Z'),
  },
  p1: {
    familyId: FAM,
    source: 'pending',
    kind: 'activity_followup',
    what: label('Toddler activities'),
  },
  p2: { familyId: FAM, source: 'pending', kind: 'spot_watch', what: label('Swim class page') },
  rSignup: {
    familyId: FAM,
    source: 'signup_confirmed',
    kind: 'registration_done',
    what: label('Saturday swim'),
  },
  rBooking: {
    familyId: FAM,
    source: 'booking',
    kind: 'registration_done',
    what: label('Swim lesson'),
    startsAt: TUE_9,
  },
  rReported: {
    familyId: FAM,
    source: 'reported_outcome',
    kind: 'registration_done',
    what: label('Riverford swim registration'),
  },
  m: {
    familyId: FAM,
    source: 'send_receipt',
    kind: 'send_done',
    what: label('A text to the co-parent'),
    sentAt: TUE_9,
    delivered: true,
  },
  x: {
    familyId: FAM,
    source: 'cancelled',
    kind: 'cancelled',
    what: label('Swim lesson'),
    startsAt: TUE_9,
  },
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
  // One row per source; aliases are e1 s1 c1 (registration) c2 (follow-up) g1 q1 w1 p1
  // p2, r1 (signup) r2 (booking) r3 (parent-reported), m1 and x1.
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
    ROW.rSignup,
    ROW.rBooking,
    ROW.rReported,
    ROW.m,
    ROW.x,
  ];
  const BACKS: Record<ReadClaimKind, Partial<Record<ClaimRowAlias, string>>> = {
    scheduled_event: {
      e1: 'backed:scheduled_row',
      s1: 'backed:parent_stated',
      r2: 'backed:booking_row',
    },
    registration_watch: { c1: 'backed:open_commitment', q1: 'backed:live_sequence', w1: 'minted' },
    spot_watch: { g1: 'backed:open_commitment', p2: 'backed:pending_commitment' },
    activity_followup: { c2: 'backed:open_commitment', p1: 'backed:pending_commitment' },
    co_parent_invite: {},
    self_referential: {},
    // A calendar row (e1) never backs a registration: planned is not registered.
    registration_done: {
      r1: 'backed:signup_confirmation',
      r2: 'backed:booking_row',
      r3: 'backed:parent_reported',
      s1: 'backed:parent_stated',
    },
    send_done: { m1: 'backed:send_receipt' },
    // m1 is delivered; an undelivered receipt is checked below.
    send_received: { m1: 'backed:send_receipt' },
    cancelled: { x1: 'backed:cancellation_row' },
  };
  const aliases = [
    'e1',
    's1',
    'c1',
    'c2',
    'g1',
    'q1',
    'w1',
    'p1',
    'p2',
    'r1',
    'r2',
    'r3',
    'm1',
    'x1',
  ] as const;
  for (const kind of Object.keys(BACKS) as ReadClaimKind[]) {
    for (const alias of aliases) {
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

describe('sent is not received', () => {
  const undelivered = { ...ROW.m, delivered: false } satisfies ClaimCandidateRow;

  it('an undelivered receipt backs "I sent it" and refuses "they got it"', () => {
    const sent = verdict('I texted your co-parent.', [claim('send_done', 'm1')], [undelivered]);
    expect(sent.resolutions[0]).toMatchObject({ status: 'backed', matchedBy: 'send_receipt' });
    const got = verdict('Your co-parent got it.', [claim('send_received', 'm1')], [undelivered]);
    expect(got.resolutions[0]).toMatchObject({
      status: 'refused',
      why: 'kind_incompatible',
      reason: 'no_delivery_record',
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

  it('a booking row and a cancellation row are day-checked too, in any language', () => {
    const cases = [
      ['Thursday 3pm swim is booked.', 'scheduled_event', 'en', 'no_scheduled_row'],
      [
        'Le cours de natation est réservé pour jeudi à 16 h.',
        'scheduled_event',
        'fr',
        'no_scheduled_row',
      ],
      [
        'She is registered for swim on Thursday at 4pm.',
        'registration_done',
        'en',
        'no_registration_record',
      ],
      ['我取消了星期四的游泳课。', 'cancelled', 'zh', 'no_cancel_record'],
      ['Cancelé la natación del jueves.', 'cancelled', 'es', 'no_cancel_record'],
    ] as const;
    for (const [body, kind, locale, reason] of cases) {
      const [row, alias] =
        kind === 'cancelled' ? [ROW.x, 'x1' as const] : [ROW.rBooking, 'r1' as const];
      const v = verdict(body, [claim(kind, alias)], [row], locale);
      expect(v.resolutions[0], body).toMatchObject({
        status: 'refused',
        why: 'day_time_conflict',
        reason,
      });
    }
    const control = verdict(
      'Tuesday 9:00 swim is booked.',
      [claim('scheduled_event', 'r1')],
      [ROW.rBooking],
    );
    expect(control.resolutions[0]).toMatchObject({ status: 'backed', matchedBy: 'booking_row' });
  });

  it('a parent-stated booking has no time and is never day-checked', () => {
    const v = verdict('Thursday 3pm checkup is booked.', [claim('scheduled_event', 's1')], [ROW.s]);
    expect(v.resolutions[0]).toMatchObject({ status: 'backed', matchedBy: 'parent_stated' });
  });
});
