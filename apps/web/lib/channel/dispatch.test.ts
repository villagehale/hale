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
 * an injected clock. Proves the AC + the founder's mirror model: policy is per
 * delivery leg (exchange channel + additive push), a ledger row per outcome
 * (suppression OR send), per-channel dedupe + caps, time_sensitive bypass, and the
 * email CASL dual-write.
 */

const TORONTO = 'America/Toronto';
const NOON = new Date('2026-06-01T16:00:00Z'); // 12:00 EDT — outside quiet hours
const NIGHT = new Date('2026-06-02T02:00:00Z'); // 22:00 EDT — inside quiet hours

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

describe('suppression matrix — every refusal writes a per-leg ledger row and sends nothing', () => {
  it('suppressed_pref when the category is disabled', async () => {
    const { ports, ledger } = makePorts({ prefs: { catReminder: false } });
    const result = await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'suppressed_pref' }]);
    expect(ledger).toEqual([expect.objectContaining({ status: 'suppressed_pref', dedupeKey: null })]);
  });

  it('suppressed_consent (email opt-out) — refused at the seam, provider never touched', async () => {
    const emailChannel = fakeChannel('email');
    const { ports, ledger } = makePorts({
      emailOptedOut: async () => true,
      channels: { email: emailChannel },
    });
    const result = await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'suppressed_consent' }]);
    expect(ledger[0]).toMatchObject({ status: 'suppressed_consent', channel: 'email' });
    expect(emailChannel.calls).toHaveLength(0);
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
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'suppressed_quiet_hours' }]);
    expect(ledger[0]?.status).toBe('suppressed_quiet_hours');
  });

  it('time_sensitive bypasses quiet hours and sends', async () => {
    const emailChannel = fakeChannel('email');
    const { ports, ledger } = makePorts({ now: () => NIGHT, channels: { email: emailChannel } });
    const result = await dispatchLoopMessage(message({ urgency: 'time_sensitive' }), ports);
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'sent' }]);
    expect(emailChannel.calls).toHaveLength(1);
    expect(ledger[0]?.status).toBe('sent');
  });

  it('suppressed_cap once the category window on that channel is full', async () => {
    const { ports, ledger } = makePorts({ countRecent: async () => 2 }); // reminder cap is 2/day
    const result = await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'suppressed_cap' }]);
    expect(ledger[0]?.status).toBe('suppressed_cap');
  });
});

describe('push mirrors, never substitutes — per-leg policy → per-leg rows', () => {
  it('a suppressed email leg alongside a delivered push leg = two rows', async () => {
    // Email opted out → suppressed_consent; push still delivers (mirror).
    const { ports, ledger } = makePorts({
      emailOptedOut: async () => true,
      hasLivePushToken: async () => true,
    });
    const result = await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);
    expect(result.legs).toEqual([
      { channel: 'email', outcome: 'suppressed_consent' },
      { channel: 'push', outcome: 'sent' },
    ]);
    expect(ledger.map((r) => `${r.channel}:${r.status}`)).toEqual([
      'email:suppressed_consent',
      'push:sent',
    ]);
  });

  it('both legs deliver, each carrying its own per-channel dedupe key', async () => {
    const { ports, ledger } = makePorts({ hasLivePushToken: async () => true });
    await dispatchLoopMessage(
      message({ category: 'weekly_plan', dedupeKey: 'fam-1:2026-W23:weekly' }),
      ports,
    );
    const sent = ledger.filter((r) => r.status === 'sent');
    expect(sent.map((r) => `${r.channel}=${r.dedupeKey}`)).toEqual([
      'email=fam-1:2026-W23:weekly:email',
      'push=fam-1:2026-W23:weekly:push',
    ]);
  });
});

describe('per-channel dedupe idempotency — a re-drain double-sends neither leg', () => {
  it('skips only the leg whose per-channel key is already sent; the mirror still delivers', async () => {
    const sentKeys = new Set(['fam-1:2026-W23:weekly:email']); // email already went last drain
    const emailChannel = fakeChannel('email');
    const pushChannel = fakeChannel('push');
    const { ports, ledger } = makePorts({
      hasLivePushToken: async () => true,
      activeDedupe: async (key) => sentKeys.has(key),
      channels: { email: emailChannel, push: pushChannel },
    });
    const result = await dispatchLoopMessage(
      message({ category: 'weekly_plan', dedupeKey: 'fam-1:2026-W23:weekly' }),
      ports,
    );
    expect(result.legs).toEqual([
      { channel: 'email', outcome: 'deduped' },
      { channel: 'push', outcome: 'sent' },
    ]);
    expect(emailChannel.calls).toHaveLength(0); // not re-sent
    expect(pushChannel.calls).toHaveLength(1); // mirror delivered
    expect(ledger.filter((r) => r.channel === 'email')).toHaveLength(0); // dedupe writes no row
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

  it('does NOT write email_sends for a push leg', async () => {
    const { ports, emailSends } = makePorts({
      prefs: { loopChannel: 'sms' },
      smsConsentLive: async () => false, // sms leg suppressed
      hasLivePushToken: async () => true, // push delivers
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
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'failed' }]);
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
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'failed' }]);
    expect(ledger[0]).toMatchObject({ status: 'failed', errorCode: 'channel_unavailable' });
  });
});
