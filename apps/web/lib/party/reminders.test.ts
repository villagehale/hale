import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  GUEST_SOFT_CTA,
  GUEST_SOFT_LINE,
  guestCancellation,
  guestReminder,
} from './guest-copy';
import {
  GUEST_SEND_HOUR_LOCAL,
  type PartyReminderDeps,
  defaultPartyReminderDeps,
  guestCancelDedupeKey,
  guestReminderDedupeKey,
  guestsEligibleForSend,
  isGuestSendSlot,
  isTomorrowLocal,
  notifyGuestsOfCancellation,
  runPartyReminderCron,
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

/**
 * VIL-267 — a guest message that could not leave is a FAILURE, not a dedupe and not
 * a clean run.
 *
 * `deduped` means "another tick already claimed this guest": a real, expected,
 * self-healing outcome. Counting an un-sendable message there hides the one thing an
 * operator needs to see, and on the cancellation path — which reports only sent/failed
 * — it disappeared entirely, so a party cancelled with nobody told read as a success.
 */
describe('a guest message that cannot leave (VIL-267)', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  // 14:10Z is 10:10 in Toronto — inside the guest send hour.
  const NOW = new Date('2026-08-05T14:10:00Z');
  // 22:00Z is 18:00 Toronto the NEXT local day.
  const STARTS_AT = new Date('2026-08-06T22:00:00Z');

  type Chain = Promise<unknown[]> & {
    from(): Chain;
    innerJoin(): Chain;
    where(): Chain;
    limit(): Promise<unknown[]>;
  };

  /** Just enough of a Drizzle handle for the two reads each path makes, in order. Each
   * link is a REAL promise of the queued rows with the builder's methods hung off it,
   * so awaiting the chain anywhere resolves the same way Drizzle's does. It hands the
   * rows back REGARDLESS of the predicate — what is under test is the sweep's
   * accounting, not a WHERE clause a fake cannot execute. */
  function partyDb(...results: unknown[][]) {
    let next = 0;
    return {
      select: () => {
        const rows = results[next++] ?? [];
        const chain: Chain = Object.assign(Promise.resolve(rows), {
          from: () => chain,
          innerJoin: () => chain,
          where: () => chain,
          limit: async () => rows,
        });
        return chain;
      },
    } as never;
  }

  const party = {
    inviteId: 'inv-1',
    familyId: 'fam-1',
    hostUserId: 'user-1',
    title: 'Nora’s birthday',
    location: 'Trinity Bellwoods',
    startsAt: STARTS_AT,
    timeZone: TORONTO,
  };

  function guest() {
    return {
      rsvpId: 'rsvp-1',
      phoneE164Encrypted: encryptString('+14165550123'),
      reminderOptInAt: new Date('2026-08-01T00:00:00Z'),
      reminderSentAt: null,
      response: 'yes' as const,
    };
  }

  /** The provider is unreachable — the shape an unconfigured deploy takes, because
   * `requireTwilioConfig` throws by NAME rather than handing back a dead client. */
  const unreachable: ChannelTransport = {
    async send() {
      throw new Error('twilio not configured: missing TWILIO_ACCOUNT_SID');
    },
  };

  function deps(released: string[]): PartyReminderDeps {
    return {
      transport: unreachable,
      claim: async () => true,
      release: async (_db, rsvpId) => {
        released.push(rsvpId);
      },
      loadTeenNames: async () => [],
      recordSend: async () => {
        throw new Error('recordSend must not run for a message that never left');
      },
    };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('counts the guest as failed — never as deduped — and releases the claim', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const released: string[] = [];

    const result = await runPartyReminderCron(partyDb([party], [guest()]), deps(released), NOW);

    expect(result).toEqual({ evaluated: 1, sent: 0, deduped: 0, failed: 1 });
    // The claim comes back, so the guest's ONE reminder is not burned by an outage.
    expect(released).toEqual(['rsvp-1']);
    expect(error).toHaveBeenCalled();
  });

  it('reports a cancellation nobody received as a failure, not a clean run', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await notifyGuestsOfCancellation(
      partyDb([party], [guest()]),
      { inviteId: 'inv-1' },
      deps([]),
      NOW,
    );

    // The path reports only sent/failed, so an invisible skip here would read as
    // "everybody was told" for a party that is off.
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(error).toHaveBeenCalled();
  });

  it('wires the REAL outbound leg into the default deps', async () => {
    // The dep is non-nullable, so "a transport is wired" is a type-level fact. What is
    // still worth asserting is WHICH one: the leg that refuses by naming its missing
    // credentials rather than reporting a send nobody made.
    const { transport } = defaultPartyReminderDeps();
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');

    await expect(transport.send({ to: '+14165550123', body: 'never leaves' })).rejects.toThrow(
      /twilio not configured/,
    );
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
