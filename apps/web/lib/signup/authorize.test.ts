import { describe, expect, it } from 'vitest';
import { authorizeSignup, isExplicitSignupUtterance } from './authorize';
import type { SignupOffer, SignupSession } from './types';

const TUE: SignupSession = {
  id: 'tue-1630',
  label: 'Tue 4:30',
  startsAt: '2026-10-06T20:30:00.000Z',
  endsAt: '2026-10-06T21:15:00.000Z',
  full: false,
  priceCents: null,
};

const WED: SignupSession = {
  id: 'wed-1000',
  label: 'Wed 10:00',
  startsAt: '2026-10-07T14:00:00.000Z',
  endsAt: '2026-10-07T14:45:00.000Z',
  full: false,
  priceCents: null,
};

function offer(sessions: SignupSession[], approvedPriceCents: number | null = null): SignupOffer {
  return {
    id: 'offer-1',
    familyId: 'family-1',
    childId: 'child-1',
    activityKey: 'swim-parent-tot',
    registrationUrl: 'https://example.test/register',
    sessions,
    approvedPriceCents,
  };
}

describe('authorization gate', () => {
  it('does not treat a bare yes as authorization', () => {
    expect(isExplicitSignupUtterance('yes')).toBe(false);
    expect(isExplicitSignupUtterance('yes please')).toBe(false);
    expect(isExplicitSignupUtterance('ok')).toBe(false);
    const decision = authorizeSignup({
      utterance: 'yes',
      offer: offer([TUE]),
      busy: [],
    });
    expect(decision).toEqual({ ok: false, reason: 'not_authorized' });
  });

  it('authorizes the only session when the parent says to sign up', () => {
    const decision = authorizeSignup({
      utterance: 'Yes, sign us up',
      offer: offer([TUE]),
      busy: [],
    });
    expect(decision).toEqual({ ok: true, activityKey: 'swim-parent-tot', sessionId: 'tue-1630' });
  });

  it('uses the session the parent named', () => {
    const decision = authorizeSignup({
      utterance: 'yes, sign us up for Wed 10:00',
      offer: offer([TUE, WED]),
      busy: [],
    });
    expect(decision).toEqual({ ok: true, activityKey: 'swim-parent-tot', sessionId: 'wed-1000' });
  });

  it('picks the one open slot that fits the calendar', () => {
    const decision = authorizeSignup({
      utterance: 'sign us up',
      offer: offer([TUE, WED]),
      busy: [{ startsAt: TUE.startsAt, endsAt: TUE.endsAt }],
    });
    expect(decision).toEqual({ ok: true, activityKey: 'swim-parent-tot', sessionId: 'wed-1000' });
  });

  it('stops when more than one session fits', () => {
    const decision = authorizeSignup({
      utterance: 'sign us up',
      offer: offer([TUE, WED]),
      busy: [],
    });
    expect(decision).toEqual({ ok: false, reason: 'ambiguous_session' });
  });

  it('stops when the named session is full', () => {
    const decision = authorizeSignup({
      utterance: 'sign us up for Tue 4:30',
      offer: offer([{ ...TUE, full: true }, WED]),
      busy: [],
    });
    expect(decision).toEqual({ ok: false, reason: 'session_full' });
  });

  it('stops when every session is full', () => {
    const decision = authorizeSignup({
      utterance: 'register us',
      offer: offer([
        { ...TUE, full: true },
        { ...WED, full: true },
      ]),
      busy: [],
    });
    expect(decision).toEqual({ ok: false, reason: 'session_full' });
  });

  it('stops when the named slot is not on the offer', () => {
    const decision = authorizeSignup({
      utterance: 'sign us up for Fri 9:00',
      offer: offer([TUE, WED]),
      busy: [],
    });
    expect(decision).toEqual({ ok: false, reason: 'session_not_offered' });
  });

  it('stops when the session has a price the parent has not approved', () => {
    const decision = authorizeSignup({
      utterance: 'yes, sign us up',
      offer: offer([{ ...TUE, priceCents: 1800 }]),
      busy: [],
    });
    expect(decision).toEqual({ ok: false, reason: 'price_not_approved' });
  });

  it('allows a price the parent already approved and a free session', () => {
    expect(
      authorizeSignup({
        utterance: 'sign us up',
        offer: offer([{ ...TUE, priceCents: 1800 }], 1800),
        busy: [],
      }).ok,
    ).toBe(true);
    expect(
      authorizeSignup({
        utterance: 'sign us up',
        offer: offer([{ ...TUE, priceCents: 0 }]),
        busy: [],
      }).ok,
    ).toBe(true);
  });

  it('does not enroll a different activity from extra words', () => {
    const decision = authorizeSignup({
      utterance: 'yes sign us up tomorrow maybe',
      offer: offer([TUE]),
      busy: [],
    });
    expect(decision).toEqual({ ok: false, reason: 'not_authorized' });
  });
});
