import { describe, expect, it } from 'vitest';
import {
  type FireState,
  type ReminderAsk,
  askedInstant,
  cleanWhat,
  deliveryFor,
  earliestQuietStart,
  fireDecision,
  inQuiet,
  quietSafeAt,
  sameFirstName,
} from './policy';

const TZ = 'America/Toronto';
// Wednesday 2026-10-28, 14:00 in Toronto (EDT, UTC-4).
const NOW = new Date('2026-10-28T18:00:00.000Z');
const GROUP_QUIET = [{ start: '21:00', end: '08:00' }];

function ask(overrides: Partial<ReminderAsk> = {}): ReminderAsk {
  return {
    for: 'sender',
    name: null,
    what: 'bring the permission form',
    date: null,
    time: null,
    inMinutes: null,
    where: 'unsaid',
    ...overrides,
  };
}

describe('askedInstant', () => {
  it('reads a relative ask to the minute', () => {
    expect(askedInstant(ask({ inMinutes: 30 }), NOW, TZ)?.toISOString()).toBe(
      '2026-10-28T18:30:00.000Z',
    );
  });

  it('reads a local date and clock time in the asker zone', () => {
    const at = askedInstant(ask({ date: '2026-10-29', time: '09:00' }), NOW, TZ);
    expect(at?.toISOString()).toBe('2026-10-29T13:00:00.000Z');
  });

  it('takes a bare clock time as today when it is still ahead, else tomorrow', () => {
    expect(askedInstant(ask({ time: '17:30' }), NOW, TZ)?.toISOString()).toBe(
      '2026-10-28T21:30:00.000Z',
    );
    expect(askedInstant(ask({ time: '09:00' }), NOW, TZ)?.toISOString()).toBe(
      '2026-10-29T13:00:00.000Z',
    );
  });

  it('asks again, rather than moving to tomorrow, for a bare clock time about now', () => {
    expect(askedInstant(ask({ time: '14:01' }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ time: '14:00' }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ time: '13:59' }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ time: '14:02' }), NOW, TZ)?.toISOString()).toBe(
      '2026-10-28T18:02:00.000Z',
    );
    expect(askedInstant(ask({ time: '13:58' }), NOW, TZ)?.toISOString()).toBe(
      '2026-10-29T17:58:00.000Z',
    );
  });

  it('crosses the November DST change on the wall clock', () => {
    const at = askedInstant(ask({ date: '2026-11-02', time: '09:00' }), NOW, TZ);
    expect(at?.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('returns null, never a guess, for a missing, malformed, past or far time', () => {
    expect(askedInstant(ask(), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ date: '2026-10-29' }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ time: '9am' }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ time: '24:00' }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ date: '2026-10-27', time: '09:00' }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ date: '2027-06-01', time: '09:00' }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ inMinutes: 0 }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ inMinutes: 1.5 }), NOW, TZ)).toBeNull();
    expect(askedInstant(ask({ inMinutes: 1 }), NOW, TZ)).toBeNull();
  });
});

describe('quietSafeAt', () => {
  it('leaves a time outside quiet hours alone', () => {
    const asked = new Date('2026-10-28T23:00:00.000Z');
    expect(quietSafeAt(asked, NOW, TZ, GROUP_QUIET)).toEqual({ at: asked, moved: null });
  });

  it('moves a late-evening ask to just before quiet hours open', () => {
    const asked = new Date('2026-10-29T01:30:00.000Z');
    const safe = quietSafeAt(asked, NOW, TZ, GROUP_QUIET);
    expect(safe?.moved).toBe('earlier');
    expect(safe?.at.toISOString()).toBe('2026-10-29T00:45:00.000Z');
    expect(inQuiet(safe?.at as Date, TZ, GROUP_QUIET)).toBe(false);
  });

  it('moves an early-morning ask to when quiet hours end', () => {
    const asked = new Date('2026-10-29T11:00:00.000Z');
    const safe = quietSafeAt(asked, NOW, TZ, GROUP_QUIET);
    expect(safe?.moved).toBe('later');
    expect(safe?.at.toISOString()).toBe('2026-10-29T12:00:00.000Z');
  });

  it('goes later when there is no time left before quiet hours open', () => {
    const lateNow = new Date('2026-10-29T00:59:00.000Z');
    const asked = new Date('2026-10-29T01:30:00.000Z');
    const safe = quietSafeAt(asked, lateNow, TZ, GROUP_QUIET);
    expect(safe?.moved).toBe('later');
    expect(safe?.at.toISOString()).toBe('2026-10-29T12:00:00.000Z');
  });

  it('honours the earliest window of several, as the Florida rule needs', () => {
    const windows = [
      { start: '20:00', end: '08:00' },
      { start: '21:30:00', end: '07:30:00' },
    ];
    const asked = new Date('2026-10-29T00:15:00.000Z');
    const safe = quietSafeAt(asked, NOW, TZ, windows);
    expect(safe?.moved).toBe('earlier');
    expect(safe?.at.toISOString()).toBe('2026-10-28T23:45:00.000Z');
  });

  it('finds a short gap, and no time at all when every minute is quiet', () => {
    const asked = new Date('2026-10-29T01:30:00.000Z');
    const gap = quietSafeAt(asked, NOW, TZ, [{ start: '00:00', end: '23:50' }]);
    expect(gap).toEqual({ at: new Date('2026-10-29T03:50:00.000Z'), moved: 'later' });
    expect(
      quietSafeAt(asked, NOW, TZ, [
        { start: '00:00', end: '12:00' },
        { start: '12:00', end: '00:00' },
      ]),
    ).toBeNull();
  });
});

describe('deliveryFor (decision 2026-10-21)', () => {
  const customer = { haleCustomer: true, directReachable: true };
  const grandparent = { haleCustomer: false, directReachable: false };

  it('keeps a non-customer in the group, even when they ask for a private text', () => {
    expect(deliveryFor({ for: 'sender', where: 'private' }, grandparent)).toBe('group');
    expect(
      deliveryFor({ for: 'sender', where: 'private' }, { ...grandparent, directReachable: true }),
    ).toBe('group');
  });

  it('gives a reachable customer their own reminder 1:1 unless they ask for the group', () => {
    expect(deliveryFor({ for: 'sender', where: 'unsaid' }, customer)).toBe('direct');
    expect(deliveryFor({ for: 'sender', where: 'private' }, customer)).toBe('direct');
    expect(deliveryFor({ for: 'sender', where: 'group' }, customer)).toBe('group');
    expect(
      deliveryFor({ for: 'sender', where: 'unsaid' }, { ...customer, directReachable: false }),
    ).toBe('group');
  });

  it('posts a reminder for someone else or for everyone in the group', () => {
    expect(deliveryFor({ for: 'person', where: 'private' }, customer)).toBe('group');
    expect(deliveryFor({ for: 'everyone', where: 'unsaid' }, customer)).toBe('group');
  });
});

describe('fireDecision', () => {
  const row = { deliverAt: NOW, delivery: 'group' as const };
  const ok: FireState = {
    now: NOW,
    groupHeld: true,
    askerSeated: true,
    recipientSeated: null,
    audienceAllowed: true,
    askerCustomer: true,
    quietNow: false,
    directReachable: true,
  };

  it('sends when every check holds', () => {
    expect(fireDecision(row, ok)).toEqual({ kind: 'send' });
  });

  it('drops a reminder whose asker stopped or left before it fired', () => {
    expect(fireDecision(row, { ...ok, askerSeated: false })).toEqual({
      kind: 'drop',
      reason: 'asker_gone',
    });
    expect(fireDecision(row, { ...ok, recipientSeated: false })).toEqual({
      kind: 'drop',
      reason: 'recipient_gone',
    });
  });

  it('checks in a fixed order and names each drop', () => {
    expect(fireDecision(row, { ...ok, groupHeld: false, askerSeated: false }).kind).toBe('drop');
    expect(fireDecision(row, { ...ok, groupHeld: false })).toMatchObject({ reason: 'group_gone' });
    const late = { ...ok, now: new Date(NOW.getTime() + 3 * 60 * 60_000) };
    expect(fireDecision(row, late)).toMatchObject({ reason: 'missed' });
    expect(fireDecision(row, { ...ok, audienceAllowed: false })).toMatchObject({
      reason: 'audience_held',
    });
    expect(fireDecision(row, { ...ok, quietNow: true })).toMatchObject({ reason: 'quiet_hours' });
    expect(
      fireDecision({ ...row, delivery: 'direct' }, { ...ok, directReachable: false }),
    ).toMatchObject({ reason: 'direct_unreachable' });
    expect(fireDecision({ ...row, delivery: 'direct' }, { ...ok, audienceAllowed: false })).toEqual(
      { kind: 'send' },
    );
  });

  it('drops a 1:1 reminder once its asker no longer counts as a customer, never posting it', () => {
    const direct = { ...row, delivery: 'direct' as const };
    expect(fireDecision(direct, { ...ok, askerCustomer: false })).toEqual({
      kind: 'drop',
      reason: 'asker_not_customer',
    });
    expect(fireDecision(row, { ...ok, askerCustomer: false })).toEqual({ kind: 'send' });
  });
});

describe('small rules', () => {
  it('tidies what to remind about and refuses an empty or oversized one', () => {
    expect(cleanWhat('  bring   the\nform ')).toBe('bring the form');
    expect(cleanWhat('   ')).toBeNull();
    expect(cleanWhat('x'.repeat(301))).toBeNull();
  });

  it('matches a model-read first name to a seat, accents and case aside', () => {
    expect(sameFirstName('Zoé', 'zoe')).toBe(true);
    expect(sameFirstName('Dan Smith', 'Dan')).toBe(true);
    expect(sameFirstName('Dana', 'Dan')).toBe(false);
    expect(sameFirstName('', 'Dan')).toBe(false);
  });

  it('takes the earliest quiet start of the phones that read a group post', () => {
    expect(earliestQuietStart(['21:00', '20:00', '21:00'], '20:00')).toBe('20:00');
    expect(earliestQuietStart([], '20:00')).toBe('20:00');
  });
});
