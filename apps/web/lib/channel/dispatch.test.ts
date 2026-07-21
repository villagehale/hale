import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOP_PREFS, type LoopPrefsView } from '~/lib/loop/prefs';
import {
  ChannelRetryableError,
  type DispatchPorts,
  type LedgerWrite,
  dispatchLoopMessage,
} from './dispatch';
import { fakeChannel, fakeRenderer } from './fakes';
import type { LoopMessage } from './types';

/**
 * VIL-213 · A2 dispatch policy. Deterministic (no LLM) → plain Vitest with Fakes +
 * an injected clock. Proves the AC: a suppressed-by-consent send is refused with a
 * ledger row; quiet-hours deferral + time_sensitive bypass; cap + dedupe; a ledger
 * row for EVERY outcome; audit per send; the email CASL dual-write.
 */

const TORONTO = 'America/Toronto';
// Noon local Toronto (EDT) — outside the default 21:30-07:30 quiet window.
const NOON = new Date('2026-06-01T16:00:00Z');
// 22:00 local Toronto (EDT) — inside quiet hours.
const NIGHT = new Date('2026-06-02T02:00:00Z');

function makePorts(overrides: Partial<DispatchPorts> & { prefs?: Partial<LoopPrefsView> } = {}) {
  const ledger: LedgerWrite[] = [];
  const emailSends: { emailType: string; recipient: string }[] = [];
  const audits: { actionTaken: string; after: Record<string, unknown> }[] = [];
  const prefs: LoopPrefsView = { ...DEFAULT_LOOP_PREFS, ...(overrides.prefs ?? {}) };

  const ports: DispatchPorts = {
    now: () => NOON,
    loadPrefs: async () => prefs,
    loadParent: async () => ({ email: 'parent@example.com', timezone: TORONTO }),
    emailOptedOut: async () => false,
    smsConsentLive: async () => true,
    hasLivePushToken: async () => false,
    countRecent: async () => 0,
    activeDedupe: async () => false,
    record: async (w) => {
      ledger.push(w);
      return `row-${ledger.length}`;
    },
    recordEmailSend: async (input) => {
      emailSends.push({ emailType: input.emailType, recipient: input.recipient });
    },
    audit: async (r) => {
      audits.push({ actionTaken: r.actionTaken, after: r.after });
    },
    channels: { email: fakeChannel('email'), sms: fakeChannel('sms'), push: fakeChannel('push') },
    renderer: fakeRenderer,
    ...overrides,
  };
  return { ports, ledger, emailSends, audits };
}

function message(over: Partial<LoopMessage> = {}): LoopMessage {
  return {
    templateKey: 'weekly-plan-v1',
    familyId: 'fam-1',
    parentUserId: 'user-1',
    category: 'reminder',
    urgency: 'normal',
    payload: {},
    ...over,
  };
}

describe('suppression matrix — every refusal writes a ledger row and sends nothing', () => {
  it('suppressed_pref when the category is disabled', async () => {
    const { ports, ledger } = makePorts({ prefs: { catReminder: false } });
    const result = await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(result).toMatchObject({ outcome: 'suppressed', suppression: 'suppressed_pref' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: 'suppressed_pref', dedupeKey: null });
  });

  it('suppressed_consent (email opt-out) — refused at the seam', async () => {
    const emailChannel = fakeChannel('email');
    const { ports, ledger } = makePorts({
      emailOptedOut: async () => true,
      channels: { email: emailChannel },
    });
    const result = await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);
    expect(result.sent).toEqual([]);
    expect(ledger.some((r) => r.status === 'suppressed_consent' && r.channel === 'email')).toBe(true);
    expect(emailChannel.calls).toHaveLength(0); // never reached the provider
  });

  it('suppressed_consent (no live SMS consent) when the exchange channel is sms', async () => {
    const smsChannel = fakeChannel('sms');
    const { ports, ledger } = makePorts({
      prefs: { loopChannel: 'sms' },
      smsConsentLive: async () => false,
      channels: { sms: smsChannel },
    });
    await dispatchLoopMessage(message(), ports);
    expect(ledger.some((r) => r.status === 'suppressed_consent' && r.channel === 'sms')).toBe(true);
    expect(smsChannel.calls).toHaveLength(0);
  });

  it('suppressed_quiet_hours for a normal message inside the window', async () => {
    const { ports, ledger } = makePorts({ now: () => NIGHT });
    const result = await dispatchLoopMessage(message({ urgency: 'normal' }), ports);
    expect(result).toMatchObject({ suppression: 'suppressed_quiet_hours' });
    expect(ledger[0]?.status).toBe('suppressed_quiet_hours');
  });

  it('time_sensitive bypasses quiet hours and sends', async () => {
    const emailChannel = fakeChannel('email');
    const { ports, ledger } = makePorts({
      now: () => NIGHT,
      channels: { email: emailChannel },
    });
    const result = await dispatchLoopMessage(message({ urgency: 'time_sensitive' }), ports);
    expect(result.sent).toEqual(['email']);
    expect(emailChannel.calls).toHaveLength(1);
    expect(ledger[0]?.status).toBe('sent');
  });

  it('suppressed_cap once the category window is full', async () => {
    // reminder cap is 2/day → countRecent returning 2 means full.
    const { ports, ledger } = makePorts({ countRecent: async () => 2 });
    const result = await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(result).toMatchObject({ suppression: 'suppressed_cap' });
    expect(ledger[0]?.status).toBe('suppressed_cap');
  });
});

describe('dedupe idempotency — a re-drain can never double-send', () => {
  it('skips entirely when the dedupe key already carries an active send', async () => {
    const emailChannel = fakeChannel('email');
    const { ports, ledger } = makePorts({
      activeDedupe: async () => true,
      channels: { email: emailChannel },
    });
    const result = await dispatchLoopMessage(message({ dedupeKey: 'fam-1:2026-W23:weekly' }), ports);
    expect(result.outcome).toBe('dedupe_skipped');
    expect(emailChannel.calls).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });

  it('the dedupe key rides the first successful send (so the next drain is blocked)', async () => {
    const { ports, ledger } = makePorts({
      hasLivePushToken: async () => true, // email + push legs
    });
    await dispatchLoopMessage(
      message({ category: 'weekly_plan', dedupeKey: 'fam-1:2026-W23:weekly' }),
      ports,
    );
    const withKey = ledger.filter((r) => r.dedupeKey === 'fam-1:2026-W23:weekly');
    expect(withKey).toHaveLength(1); // exactly one leg carries the key (unique-where-not-null)
    expect(withKey[0]?.channel).toBe('email'); // the exchange (first) leg
    expect(ledger.filter((r) => r.status === 'sent')).toHaveLength(2); // email + push both sent
  });
});

describe('email CASL dual-write + audit', () => {
  it('writes channel_messages + email_sends + an audit row on a real email send', async () => {
    const { ports, ledger, emailSends, audits } = makePorts();
    await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);
    expect(ledger.filter((r) => r.channel === 'email' && r.status === 'sent')).toHaveLength(1);
    expect(emailSends).toEqual([{ emailType: 'weekly_plan', recipient: 'parent@example.com' }]);
    expect(audits).toEqual([
      { actionTaken: 'channel_sent', after: { channel: 'email', category: 'weekly_plan' } },
    ]);
  });

  it('does NOT write email_sends for a push-only leg (no dual-write off email)', async () => {
    const { ports, emailSends } = makePorts({
      prefs: { loopChannel: 'sms' },
      smsConsentLive: async () => false, // sms leg suppressed
      hasLivePushToken: async () => true, // push still delivers
    });
    await dispatchLoopMessage(message(), ports);
    expect(emailSends).toEqual([]);
  });
});

describe('provider outcomes', () => {
  it('records a failed row on a permanent error', async () => {
    const { ports, ledger } = makePorts({
      channels: {
        email: fakeChannel('email', {
          status: 'error',
          transient: false,
          code: 'invalid_recipient',
          message: 'bad address',
        }),
      },
    });
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.failed).toEqual(['email']);
    expect(ledger[0]).toMatchObject({ status: 'failed', errorCode: 'invalid_recipient' });
  });

  it('throws ChannelRetryableError on a transient error and writes no terminal row', async () => {
    const { ports, ledger } = makePorts({
      channels: {
        email: fakeChannel('email', {
          status: 'error',
          transient: true,
          code: 'rate_limited',
          message: 'try later',
        }),
      },
    });
    await expect(dispatchLoopMessage(message(), ports)).rejects.toBeInstanceOf(ChannelRetryableError);
    expect(ledger).toHaveLength(0);
  });

  it('records a failed row (channel_unavailable) when no adapter is wired for a leg', async () => {
    const { ports, ledger } = makePorts({ channels: {} });
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.failed).toEqual(['email']);
    expect(ledger[0]).toMatchObject({ status: 'failed', errorCode: 'channel_unavailable' });
  });
});
