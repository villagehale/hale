import { describe, expect, it } from 'vitest';
import {
  GUEST_SOFT_CTA,
  GUEST_SOFT_LINE,
  guestCancellation,
  guestReminder,
} from './guest-copy';
import {
  GUEST_SEND_HOUR_LOCAL,
  guestCancelDedupeKey,
  guestReminderDedupeKey,
  guestsEligibleForSend,
  isGuestSendSlot,
  isTomorrowLocal,
} from './reminders';

/**
 * VIL-245 · M10 — the CASL guards on the ONE path in Hale that texts non-users.
 *
 * The promise the RSVP page makes is that a guest gets NOTHING they did not ask for.
 * These tests are written against that promise, not against the current filter: every
 * case below is a way the promise could break, and each must refuse.
 */

const TORONTO = 'America/Toronto';

const row = (over: Partial<Parameters<typeof guestsEligibleForSend>[0][number]> = {}) => ({
  rsvpId: 'r1',
  phoneE164Encrypted: 'blob',
  reminderOptInAt: new Date('2026-08-01T00:00:00Z'),
  reminderSentAt: null,
  response: 'yes' as const,
  ...over,
});

describe('guestsEligibleForSend — no unsolicited guest sends', () => {
  it('NEVER sends to a guest who did not opt in', () => {
    // The load-bearing case. A guest with no opt-in has no consent, and (by the table's
    // CHECK) no stored number either — but the filter must refuse on the consent alone,
    // because the consent is the thing that was or was not given.
    expect(
      guestsEligibleForSend([row({ reminderOptInAt: null, phoneE164Encrypted: null })]),
    ).toEqual([]);
  });

  it('refuses even when an opt-in is absent but a number somehow is not', () => {
    // Unrepresentable via the CHECK, so this can only be a half-erased row. The safe
    // reading of a half-erased consent is "withdrawn".
    expect(guestsEligibleForSend([row({ reminderOptInAt: null })])).toEqual([]);
  });

  it('refuses when consent is present but the number was erased by a STOP', () => {
    expect(guestsEligibleForSend([row({ phoneE164Encrypted: null })])).toEqual([]);
  });

  it("never reminds a guest who said they can't make it", () => {
    expect(guestsEligibleForSend([row({ response: 'no' })])).toEqual([]);
  });

  it('reminds a maybe — they asked, and a maybe is who a reminder is for', () => {
    expect(guestsEligibleForSend([row({ response: 'maybe' })])).toHaveLength(1);
  });

  it('never sends a second reminder to a guest already reminded', () => {
    expect(guestsEligibleForSend([row({ reminderSentAt: new Date() })])).toEqual([]);
  });

  it('does let a CANCELLATION reach a guest whose reminder already went out', () => {
    // News, not a repeat: they were told the party was on.
    expect(
      guestsEligibleForSend([row({ reminderSentAt: new Date() })], { includeReminded: true }),
    ).toHaveLength(1);
  });

  it('still refuses a non-opted-in guest on the cancellation path', () => {
    // The widest path must not widen the consent check.
    expect(
      guestsEligibleForSend([row({ reminderOptInAt: null, phoneE164Encrypted: null })], {
        includeReminded: true,
      }),
    ).toEqual([]);
  });

  it('passes through only the eligible rows from a mixed party', () => {
    const eligible = guestsEligibleForSend([
      row({ rsvpId: 'opted-in' }),
      row({ rsvpId: 'no-consent', reminderOptInAt: null, phoneE164Encrypted: null }),
      row({ rsvpId: 'declined', response: 'no' }),
    ]);
    expect(eligible.map((g) => g.rsvpId)).toEqual(['opted-in']);
  });
});

describe('guest-facing copy', () => {
  it('carries the way out on every message', () => {
    expect(guestReminder("Max's 5th birthday", 'Saturday at 2:00 PM', '14 Elm St')).toContain(
      'Reply STOP',
    );
    expect(guestCancellation("Max's 5th birthday")).toContain('Reply STOP');
  });

  it('names Hale as the sender, so a text from an unknown number is not a mystery', () => {
    expect(guestReminder('x', 'y', null)).toContain('Hale');
    expect(guestCancellation('x')).toContain('Hale');
  });

  it('says why they are receiving it — the consent, restated', () => {
    expect(guestReminder('x', 'y', null)).toContain('You asked me to remind you');
  });

  it('NEVER markets to a guest in a message Hale sends them', () => {
    // The one soft line lives on the confirmation screen a guest chose to visit. A
    // message pushed to their phone is not that.
    for (const body of [guestReminder('x', 'y', 'z'), guestCancellation('x')]) {
      expect(body).not.toContain(GUEST_SOFT_LINE);
      expect(body).not.toContain(GUEST_SOFT_CTA);
    }
  });
});

describe('send timing', () => {
  it('only fires in the host family’s mid-morning hour', () => {
    // 14:00Z is 10:00 in Toronto (EDT).
    expect(isGuestSendSlot(new Date('2026-08-21T14:00:00Z'), TORONTO)).toBe(true);
    expect(isGuestSendSlot(new Date('2026-08-21T14:59:00Z'), TORONTO)).toBe(true);
    expect(GUEST_SEND_HOUR_LOCAL).toBe(10);
  });

  it('never fires in the middle of the night, whatever the server clock says', () => {
    // 06:00Z is 02:00 in Toronto — the hour a guest text must never arrive.
    expect(isGuestSendSlot(new Date('2026-08-21T06:00:00Z'), TORONTO)).toBe(false);
    expect(isGuestSendSlot(new Date('2026-08-21T02:00:00Z'), TORONTO)).toBe(false);
  });

  it('reads "tomorrow" as a LOCAL calendar day, not a 24-hour offset', () => {
    const now = new Date('2026-08-21T14:00:00Z'); // Friday 10:00 Toronto
    // Saturday 2pm local — tomorrow.
    expect(isTomorrowLocal(new Date('2026-08-22T18:00:00Z'), now, TORONTO)).toBe(true);
    // Saturday 09:00 local is still tomorrow, though it is under 24 hours away.
    expect(isTomorrowLocal(new Date('2026-08-22T13:00:00Z'), now, TORONTO)).toBe(true);
    // Sunday is not.
    expect(isTomorrowLocal(new Date('2026-08-23T18:00:00Z'), now, TORONTO)).toBe(false);
    // Today is not.
    expect(isTomorrowLocal(new Date('2026-08-21T22:00:00Z'), now, TORONTO)).toBe(false);
  });
});

describe('dedupe keys', () => {
  it('keys a reminder on the guest, so a re-drain cannot double-text them', () => {
    expect(guestReminderDedupeKey('abc')).toBe('rsvp:reminder:abc');
    expect(guestReminderDedupeKey('abc')).not.toBe(guestReminderDedupeKey('def'));
  });

  it('keeps the cancellation on its own key so it is not deduped by the reminder', () => {
    expect(guestCancelDedupeKey('abc')).not.toBe(guestReminderDedupeKey('abc'));
  });
});
