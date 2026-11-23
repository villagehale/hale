import { getFlag, isEnabled } from '@hale/flags';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailAlertOccasion, emailAlertOccasionKey } from './email-alert';
import { readAppointmentJudgment } from './email-alert-appointment';
import { EMAIL_ALERT_ONCE_ENABLED_ENV, emailAlertOnceEnabled } from './email-alert-once-flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * VIL-762 · the Nov 17 duplicate, checked against the key the send path actually
 * builds. Prod: one integration, one start (2026-11-18 20:45Z), one occasion
 * digest, two Gmail threads. The four other guesses are recorded beside it.
 */
describe('the RAMI duplicate, from the occasion key', () => {
  const start = '2026-11-18T20:45:00.000Z';
  const event = {
    title: 'Kids haircut',
    childRef: null,
    originalTime: null as string | null,
    newTime: start,
    location: "RAMI's Lounge",
  };
  const confirmation = {
    kind: 'booking_confirmation' as const,
    event,
    matchedEventRef: null,
  };
  const reminder = {
    kind: 'reminder_only' as const,
    event: { ...event, originalTime: start, newTime: null },
    matchedEventRef: null,
  };

  it('hypothesis: two threads, one instant — the key includes the thread, so both send', () => {
    const occasion = emailAlertOccasion(confirmation, 'msg-confirm');
    expect(emailAlertOccasion(reminder, 'msg-remind')).toBe(occasion);
    const first = emailAlertOccasionKey('connection', 'thread-confirm', occasion);
    const second = emailAlertOccasionKey('connection', 'thread-remind', occasion);
    expect(first).not.toBe(second);
    expect(first.split(':').slice(0, 2).join(':')).toBe(second.split(':').slice(0, 2).join(':'));
    expect(first.split(':').at(-1)).toBe(second.split(':').at(-1));
  });

  it('not the message-id fallback: an instant is one occasion, not one key per email', () => {
    expect(emailAlertOccasion(confirmation, 'msg-confirm')).not.toContain('msg-confirm');
    expect(emailAlertOccasion(reminder, 'msg-remind')).not.toContain('msg-remind');
  });

  it('not a drifted instant: confirmation newTime and reminder originalTime hash the same', () => {
    expect(emailAlertOccasion(confirmation, 'msg-confirm')).toBe(
      `on|${new Date(start).toISOString()}`,
    );
  });

  it('a missing instant really does key on the message, which this pair did not', () => {
    const bare = {
      kind: 'new_event' as const,
      event: { ...event, newTime: null, originalTime: null },
      matchedEventRef: null,
    };
    expect(emailAlertOccasion(bare, 'msg-a')).toBe('msg:msg-a');
    expect(emailAlertOccasion(bare, 'msg-b')).toBe('msg:msg-b');
  });
});

describe('emailAlertOnceEnabled', () => {
  it('is off unless the value is exactly true', () => {
    vi.stubEnv(EMAIL_ALERT_ONCE_ENABLED_ENV, undefined);
    expect(emailAlertOnceEnabled()).toBe(false);
    for (const value of ['', 'TRUE', 'true\n', ' true', 'on', '1']) {
      vi.stubEnv(EMAIL_ALERT_ONCE_ENABLED_ENV, value);
      expect(emailAlertOnceEnabled(), JSON.stringify(value)).toBe(false);
    }
    vi.stubEnv(EMAIL_ALERT_ONCE_ENABLED_ENV, 'true');
    expect(emailAlertOnceEnabled()).toBe(true);
  });

  it('is env-only, so PostHog cannot override the exact env value', () => {
    expect(getFlag('email-alert-once').envOnly).toBe(true);
    const posthog = { POSTHOG_FLAGS_ENABLED: 'true' };
    expect(
      isEnabled('email-alert-once', undefined, {
        ...posthog,
        EMAIL_ALERT_ONCE_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(
      isEnabled('email-alert-once', undefined, {
        ...posthog,
        EMAIL_ALERT_ONCE_ENABLED: 'true\n',
      }),
    ).toBe(false);
    expect(isEnabled('email-alert-once', undefined, posthog)).toBe(false);
  });
});

describe('readAppointmentJudgment', () => {
  const ids = new Set(['rami', 'storytime']);

  it('accepts a same-visit id and drops clashes of that same id', () => {
    expect(
      readAppointmentJudgment(
        { same_as: 'rami', clashes_with: ['rami', 'storytime'] },
        ids,
        'reminder_only',
      ),
    ).toEqual({ status: 'judged', judgment: { sameAs: 'rami', clashes: [] } });
  });

  it('keeps a clash that is a different commitment', () => {
    expect(
      readAppointmentJudgment({ same_as: '', clashes_with: ['rami'] }, ids, 'booking_confirmation'),
    ).toEqual({ status: 'judged', judgment: { sameAs: null, clashes: ['rami'] } });
  });

  it('a cancellation is news, even when the model calls it the same visit', () => {
    expect(
      readAppointmentJudgment({ same_as: 'rami', clashes_with: [] }, ids, 'cancellation'),
    ).toEqual({ status: 'judged', judgment: { sameAs: null, clashes: [] } });
  });

  it('an id that was not handed over is unusable', () => {
    expect(
      readAppointmentJudgment({ same_as: 'Kids haircut', clashes_with: [] }, ids, 'reminder_only'),
    ).toEqual({ status: 'unjudged', reason: 'unusable' });
    expect(
      readAppointmentJudgment({ same_as: '', clashes_with: ['somewhere else'] }, ids, 'new_event'),
    ).toEqual({ status: 'unjudged', reason: 'unusable' });
  });
});
