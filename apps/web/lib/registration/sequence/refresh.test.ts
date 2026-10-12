import { describe, expect, it } from 'vitest';
import type { LiveRegistrationReading } from '../live-reading';
import { registrationAnchor } from '../read';
import { decideRegistrationRefresh } from './refresh';

const now = new Date('2026-10-10T12:00:00Z');
// Lifecycle input, not a stubbed model: the evidence gate is tested in live-reading.
function reading(
  date: string,
  time: string | null = '09:00',
  timeZone = 'America/New_York',
): LiveRegistrationReading {
  return {
    sourceUrl: 'https://example.com/swim',
    checkedAt: now,
    reader: 'ai',
    timeZone,
    status: 'verified',
    dates: [{ kind: 'general_open', date, time, evidence: ['published registration date'] }],
  };
}
const state = {
  anchor: new Date('2026-10-20T13:00:00Z'),
  pending: null,
  pausedAt: null,
  reviewApproved: false,
};

describe('registration refresh decisions', () => {
  it('checks distant dates daily, near/unknown/failed dates hourly', () => {
    expect(decideRegistrationRefresh(state, reading('2026-10-20'), false, now).nextCheckAt).toEqual(
      new Date('2026-10-11T12:00:00Z'),
    );
    expect(decideRegistrationRefresh(state, reading('2026-10-12'), false, now).nextCheckAt).toEqual(
      new Date('2026-10-10T13:00:00Z'),
    );
    const failed = {
      ...reading('2026-10-12'),
      status: 'unreadable',
      reason: 'fetch_failed',
    } as LiveRegistrationReading;
    expect(decideRegistrationRefresh(state, failed, false, now)).toMatchObject({
      paused: true,
      nextCheckAt: new Date('2026-10-10T13:00:00Z'),
    });
  });
  it('moves earlier automatically, pauses later for a separate approval', () => {
    expect(decideRegistrationRefresh(state, reading('2026-10-12'), false, now)).toMatchObject({
      paused: false,
      anchor: new Date('2026-10-12T13:00:00Z'),
      pending: { kind: 'earlier' },
    });
    expect(decideRegistrationRefresh(state, reading('2026-10-22'), false, now)).toMatchObject({
      paused: true,
      anchor: state.anchor,
      pending: { kind: 'later', candidateAt: '2026-10-22T13:00:00.000Z' },
    });
  });
  it('an approved candidate must still match a fresh read', () => {
    const later = decideRegistrationRefresh(state, reading('2026-10-22'), false, now);
    const waiting = { ...state, pending: later.pending, pausedAt: now, reviewApproved: true };
    expect(decideRegistrationRefresh(waiting, reading('2026-10-22'), false, now)).toMatchObject({
      paused: false,
      anchor: new Date('2026-10-22T13:00:00Z'),
    });
    expect(decideRegistrationRefresh(waiting, reading('2026-10-23'), false, now)).toMatchObject({
      paused: true,
      resetReview: true,
    });
  });
  it('a failed read preserves the date candidate and its approval, and retries hourly', () => {
    const later = decideRegistrationRefresh(state, reading('2026-10-22'), false, now);
    const failed = {
      ...reading('2026-10-22'),
      status: 'unreadable',
      reason: 'fetch_failed',
    } as LiveRegistrationReading;
    const unavailable = decideRegistrationRefresh(
      { ...state, pending: later.pending, pausedAt: now },
      failed,
      false,
      now,
    );
    expect(unavailable).toMatchObject({
      paused: true,
      resetReview: false,
      pending: { kind: 'unavailable', reviewCandidate: later.pending },
    });
    expect(
      decideRegistrationRefresh(
        { ...state, pending: unavailable.pending, pausedAt: now, reviewApproved: true },
        reading('2026-10-22'),
        false,
        now,
      ),
    ).toMatchObject({ paused: false, anchor: new Date('2026-10-22T13:00:00Z') });
    expect(later.nextCheckAt).toEqual(new Date('2026-10-10T13:00:00Z'));
  });
  it('the same instant with changed clock precision or zone cannot reuse approval', () => {
    const later = decideRegistrationRefresh(state, reading('2026-10-22', '12:00'), false, now);
    const decision = decideRegistrationRefresh(
      { ...state, pending: later.pending, pausedAt: now, reviewApproved: true },
      reading('2026-10-22', null),
      false,
      now,
    );
    expect(decision).toMatchObject({ paused: true, resetReview: true });
  });
  it('keeps an unsent notice when the next refresh sees the same date', () => {
    const earlier = decideRegistrationRefresh(state, reading('2026-10-12'), false, now);
    expect(
      decideRegistrationRefresh(
        { ...state, anchor: earlier.anchor, pending: earlier.pending },
        reading('2026-10-12'),
        false,
        now,
      ).pending,
    ).toEqual(earlier.pending);
  });
  it('date-only does not enable a minute-specific opening', () => {
    expect(
      decideRegistrationRefresh(
        { ...state, anchor: null },
        reading('2026-10-20', null, 'Europe/London'),
        false,
        now,
      ),
    ).toMatchObject({ publishedTime: false, anchor: new Date('2026-10-20T11:00:00Z') });
  });
  it('uses source DST, not server or parent timezone, and rejects nonexistent clocks', () => {
    expect(
      registrationAnchor(reading('2026-11-02'), {
        kind: 'general_open',
        date: '2026-11-02',
        time: '09:00',
        evidence: [],
      }),
    ).toEqual(new Date('2026-11-02T14:00:00Z'));
    expect(() =>
      registrationAnchor(reading('2027-03-14'), {
        kind: 'general_open',
        date: '2027-03-14',
        time: '02:30',
        evidence: [],
      }),
    ).toThrow();
  });
});
