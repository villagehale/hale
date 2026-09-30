import { describe, expect, it } from 'vitest';
import { falseBookingSignal, guardBookingConfirmation } from './booking-guard';

describe('falseBookingSignal', () => {
  it('refuses a waitlist placement and a waitlist update', () => {
    expect(
      falseBookingSignal({
        subject: 'Waitlist Update',
        snippet: 'You are on the waitlist for Tadpole Swim.',
      }),
    ).toBe('waitlist');
    expect(
      falseBookingSignal({
        subject: 'Northwind Recreation',
        snippet: "You've been added to the waiting list.",
      }),
    ).toBe('waitlist');
  });

  it('refuses a registration-opens notice', () => {
    expect(
      falseBookingSignal({
        subject: 'Fall registration opens October 7',
        snippet: 'Registration opens October 7 at 7:00 a.m. for residents.',
      }),
    ).toBe('registration_opens');
    expect(
      falseBookingSignal({
        subject: 'Northwind Recreation',
        snippet: 'Sign-up will open next Tuesday.',
      }),
    ).toBe('registration_opens');
  });

  it('refuses reminder-only mail, including a reminder that the family is registered', () => {
    expect(
      falseBookingSignal({
        subject: 'Reminder: Tadpole Swim is this Saturday',
        snippet: "This is a reminder that you're registered for Tadpole Swim.",
      }),
    ).toBe('reminder_only');
    expect(
      falseBookingSignal({
        subject: 'Northwind Recreation',
        snippet: 'Just a reminder — Tadpole Swim meets Saturday at 9:00 a.m.',
      }),
    ).toBe('reminder_only');
  });

  it('lets a real receipt through, including one that promoted the family off the waitlist', () => {
    expect(
      falseBookingSignal({
        subject: 'Registration confirmation — Tadpole Swim',
        snippet: "You're registered for Tadpole Swim. First class is Saturday, October 4.",
      }),
    ).toBeNull();
    expect(
      falseBookingSignal({
        subject: 'Payment receipt — Tadpole Swim',
        snippet: 'Receipt for Tadpole Swim. You are registered.',
      }),
    ).toBeNull();
    expect(
      falseBookingSignal({
        subject: 'A spot opened up',
        snippet: 'You are off the waitlist and you are registered for Tadpole Swim.',
      }),
    ).toBeNull();
  });

  it('does not treat an adult ticket, a flight, or a restaurant as a waitlist', () => {
    expect(
      falseBookingSignal({
        subject: 'Your tickets — Thursday Jazz Quartet',
        snippet: 'Two adult tickets are confirmed for Thursday at 8:00 p.m.',
      }),
    ).toBeNull();
    expect(
      falseBookingSignal({
        subject: 'Your flight to Calgary is confirmed',
        snippet: 'Northair flight NA204 departs Thursday at 6:10 a.m.',
      }),
    ).toBeNull();
    expect(
      falseBookingSignal({
        subject: 'Your table at Birch Room',
        snippet: 'A table for two is booked for Friday at 7:00 p.m.',
      }),
    ).toBeNull();
  });
});

describe('guardBookingConfirmation', () => {
  const waitlist = {
    subject: 'Waitlist Update',
    snippet: 'You are on the waitlist for Tadpole Swim.',
  };

  it('rewrites only a booking_confirmation the envelope contradicts', () => {
    expect(guardBookingConfirmation('booking_confirmation', waitlist)).toBe('reminder_only');
    expect(guardBookingConfirmation('cancellation', waitlist)).toBe('cancellation');
    expect(
      guardBookingConfirmation('booking_confirmation', {
        subject: 'Registration confirmation — Tadpole Swim',
        snippet: "You're registered for Tadpole Swim.",
      }),
    ).toBe('booking_confirmation');
  });
});
