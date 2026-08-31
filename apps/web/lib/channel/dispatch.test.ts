import { describe, expect, it } from 'vitest';
import { createTwilioSmsChannel } from '~/lib/channel/adapters/twilio-sms';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
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
 * an injected clock. Proves the AC: policy is per delivery leg (the parent's
 * exchange channel), a ledger row per outcome (suppression OR send), per-channel
 * dedupe + caps, time_sensitive bypass, and the email CASL dual-write.
 */

const TORONTO = 'America/Toronto';
const NOON = new Date('2026-06-01T16:00:00Z'); // 12:00 EDT — outside quiet hours
const NIGHT = new Date('2026-06-02T02:00:00Z'); // 22:00 EDT — inside quiet hours

interface Capture {
  event: string;
  distinctId: string;
  properties: Record<string, unknown>;
}

function makePorts(overrides: Partial<DispatchPorts> & { prefs?: Partial<LoopPrefsView> } = {}) {
  const ledger: LedgerWrite[] = [];
  const emailSends: { emailType: string; recipient: string }[] = [];
  const audits: { actionTaken: string; after: Record<string, unknown> }[] = [];
  const captures: Capture[] = [];
  const threaded: { familyId: string; parentUserId: string; body: string }[] = [];
  const prefs: LoopPrefsView = { ...DEFAULT_LOOP_PREFS, ...(overrides.prefs ?? {}) };

  const ports: DispatchPorts = {
    now: () => NOON,
    loadPrefs: async () => prefs,
    loadParent: async () => ({ email: 'parent@example.com', timezone: TORONTO }),
    emailOptedOut: async () => false,
    smsConsentLive: async () => true,
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
    capture: async (event, distinctId, properties = {}) => {
      captures.push({ event, distinctId, properties });
      return 'sent';
    },
    threadMessage: async (input) => {
      threaded.push(input);
    },
    channels: { email: fakeChannel('email'), sms: fakeChannel('sms') },
    renderer: fakeRenderer,
    ...overrides,
  };
  return { ports, ledger, emailSends, audits, captures, threaded };
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

describe('per-channel dedupe idempotency — a re-drain never double-sends', () => {
  it('skips the leg whose per-channel key is already sent, writing no row', async () => {
    const sentKeys = new Set(['fam-1:2026-W23:weekly:email']); // email already went last drain
    const emailChannel = fakeChannel('email');
    const { ports, ledger } = makePorts({
      activeDedupe: async (key) => sentKeys.has(key),
      channels: { email: emailChannel },
    });
    const result = await dispatchLoopMessage(
      message({ category: 'weekly_plan', dedupeKey: 'fam-1:2026-W23:weekly' }),
      ports,
    );
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'deduped' }]);
    expect(emailChannel.calls).toHaveLength(0); // not re-sent
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

  it('does NOT write email_sends for a non-email leg', async () => {
    const { ports, emailSends } = makePorts({ prefs: { loopChannel: 'sms' } });
    await dispatchLoopMessage(message(), ports);
    expect(emailSends).toEqual([]);
  });
});

describe("the parent's own text thread", () => {
  it('threads a delivered SMS leg with the body that went on the wire', async () => {
    // The weekly plan is a thing Hale SAID, and the parent answers it by text.
    // `channel_messages` stores no body (rule #1), so this is the only record a coach
    // turn can read the reply against.
    const { ports, threaded } = makePorts({ prefs: { loopChannel: 'sms' } });
    await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);

    expect(threaded).toEqual([
      { familyId: 'fam-1', parentUserId: 'user-1', body: 'weekly-plan-v1' },
    ]);
  });

  it('threads the SMS leg only — an email is not a text', async () => {
    // The thread is the SMS thread (channelSmsNoteKey).
    const { ports, threaded } = makePorts({ prefs: { loopChannel: 'sms' } });
    const result = await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);

    expect(result.legs.map((l) => `${l.channel}:${l.outcome}`)).toEqual(['sms:sent']);
    expect(threaded).toHaveLength(1);

    const viaEmail = makePorts();
    await dispatchLoopMessage(message({ category: 'weekly_plan' }), viaEmail.ports);
    expect(viaEmail.threaded).toEqual([]);
  });

  it('threads nothing when the SMS leg never reached the provider', async () => {
    // The positive control: same channel, same message, refused. A suppressed leg is
    // not something Hale said.
    const { ports, threaded } = makePorts({
      prefs: { loopChannel: 'sms' },
      smsConsentLive: async () => false,
    });
    const result = await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);

    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'suppressed_consent' }]);
    expect(threaded).toEqual([]);
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
    // The reason rides the leg so a caller can tell a refused address from an
    // unconfigured channel without re-reading the ledger row.
    expect(result.legs).toEqual([
      { channel: 'email', outcome: 'failed', reason: 'invalid_recipient' },
    ]);
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

  it('records the failed row for a permanent SMS refusal, through the REAL Twilio adapter', async () => {
    // The branch above proves the policy with a fake; this proves the SMS leg can
    // actually reach it. It could not before: the transport threw a bare string error,
    // the adapter had no error variant, and every permanent refusal came out of the
    // dispatch as a throw — a retry loop against a parent who had opted out.
    const { ports, ledger, captures } = makePorts({
      prefs: { loopChannel: 'sms' },
      channels: {
        sms: createTwilioSmsChannel({
          transport: {
            async send(): Promise<{ providerMessageId: string }> {
              throw new TwilioSendError('21610', 400);
            },
          },
          resolveTarget: async () => '+14165550100',
          configured: true,
        }),
      },
    });

    const result = await dispatchLoopMessage(message(), ports);

    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'failed', reason: '21610' }]);
    expect(ledger[0]).toMatchObject({ status: 'failed', channel: 'sms', errorCode: '21610' });
    expect(captures[0]).toMatchObject({
      event: 'loop_message_failed',
      properties: { channel: 'sms', reason: 'failed' },
    });
  });

  it('records a failed row (channel_unavailable) when no adapter is wired for a leg', async () => {
    const { ports, ledger } = makePorts({ channels: {} });
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.legs).toEqual([
      { channel: 'email', outcome: 'failed', reason: 'channel_unavailable' },
    ]);
    expect(ledger[0]).toMatchObject({ status: 'failed', errorCode: 'channel_unavailable' });
  });
});

describe('X1 (VIL-227) taxonomy — one ledger row ⇒ exactly one analytics event', () => {
  it('a suppression writes one ledger row and one loop_message_failed capture, reason = the suppression status', async () => {
    const { ports, ledger, captures } = makePorts({ prefs: { catReminder: false } });
    await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(captures).toHaveLength(ledger.length);
    expect(captures).toEqual([
      {
        event: 'loop_message_failed',
        distinctId: 'user-1',
        properties: { channel: 'email', category: 'reminder', templateKey: 'weekly-plan-v1', reason: 'suppressed_pref' },
      },
    ]);
  });

  it('a real send writes one ledger row and one loop_message_sent capture, reason = sent', async () => {
    const { ports, ledger, captures } = makePorts();
    await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);
    expect(captures).toHaveLength(ledger.length);
    expect(captures).toEqual([
      {
        event: 'loop_message_sent',
        distinctId: 'user-1',
        properties: { channel: 'email', category: 'weekly_plan', templateKey: 'weekly-plan-v1', reason: 'sent' },
      },
    ]);
  });

  /**
   * The SMS leg's row is born 'queued' — Twilio accepted it, the carrier has not
   * confirmed it (channel/ledger.ts acceptedStatus). The capture must NOT follow the
   * status blindly: a queued SMS is a SEND, and pairing it with loop_message_failed
   * would report every text Hale sends as a failure.
   */
  it('an sms leg is ledgered queued, and still captured as a send', async () => {
    const { ports, ledger, captures } = makePorts({
      prefs: { loopChannel: 'sms' },
      channels: { sms: fakeChannel('sms') },
    });

    const result = await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);

    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(ledger[0]).toMatchObject({ channel: 'sms', status: 'queued' });
    expect(captures[0]).toMatchObject({
      event: 'loop_message_sent',
      properties: { channel: 'sms', reason: 'queued' },
    });
  });

  it('a permanent provider error writes one ledger row and one loop_message_failed capture', async () => {
    const { ports, ledger, captures } = makePorts({
      channels: { email: fakeChannel('email', { status: 'error', transient: false, code: 'invalid_recipient', message: 'bad' }) },
    });
    await dispatchLoopMessage(message(), ports);
    expect(captures).toHaveLength(ledger.length);
    expect(captures[0]).toMatchObject({ event: 'loop_message_failed', properties: { reason: 'failed' } });
  });

  it('a suppressed leg fires its paired capture, one per row', async () => {
    const { ports, ledger, captures } = makePorts({ emailOptedOut: async () => true });
    await dispatchLoopMessage(message({ category: 'weekly_plan' }), ports);
    expect(captures).toHaveLength(ledger.length);
    expect(captures.map((c) => `${c.properties.channel}:${c.event}`)).toEqual([
      'email:loop_message_failed',
    ]);
  });

  it('a deduped leg writes NEITHER a ledger row nor a capture (no row ⇒ no event)', async () => {
    const { ports, ledger, captures } = makePorts({ activeDedupe: async () => true });
    const result = await dispatchLoopMessage(message({ dedupeKey: 'fam-1:key' }), ports);
    expect(result.legs).toEqual([{ channel: 'email', outcome: 'deduped' }]);
    expect(ledger).toHaveLength(0);
    expect(captures).toHaveLength(0);
  });

  it('a transient (retryable) error writes no terminal row and fires no capture', async () => {
    const { ports, ledger, captures } = makePorts({
      channels: { email: fakeChannel('email', { status: 'error', transient: true, code: 'rate_limited', message: 'later' }) },
    });
    await expect(dispatchLoopMessage(message(), ports)).rejects.toBeInstanceOf(ChannelRetryableError);
    expect(ledger).toHaveLength(0);
    expect(captures).toHaveLength(0);
  });
});

/**
 * VIL-249 — a message pinned to ONE channel. An ICS invite exists only as an email
 * (its whole payload is a text/calendar attachment), so it must reach a parent whose
 * exchange channel is SMS.
 */
describe('WhatsApp is a reply pipe, never a proactive one (Meta session policy)', () => {
  it('REFUSES a whatsapp leg outright with a named outcome — before prefs, before render, before any adapter', async () => {
    const { ports, ledger, captures } = makePorts({
      // Even a wired whatsapp adapter must never be reached from the dispatch.
      channels: { email: fakeChannel('email'), sms: fakeChannel('sms'), whatsapp: fakeChannel('whatsapp') },
    });

    const result = await dispatchLoopMessage(message({ channel: 'whatsapp' }), ports);

    expect(result.legs).toEqual([
      { channel: 'whatsapp', outcome: 'failed', reason: 'whatsapp_proactive_unsupported' },
    ]);
    expect(ledger).toEqual([
      expect.objectContaining({
        channel: 'whatsapp',
        status: 'failed',
        errorCode: 'whatsapp_proactive_unsupported',
      }),
    ]);
    expect(captures).toEqual([
      expect.objectContaining({
        event: 'loop_message_failed',
        properties: expect.objectContaining({ channel: 'whatsapp' }),
      }),
    ]);
  });
});

describe('a channel-pinned message', () => {
  it('dispatches on the pinned channel rather than the parent’s loop channel', async () => {
    const email = fakeChannel('email');
    const sms = fakeChannel('sms');
    const { ports, ledger } = makePorts({
      prefs: { loopChannel: 'sms' },
      channels: { email, sms },
    });

    const result = await dispatchLoopMessage(message({ channel: 'email', category: 'approval' }), ports);

    expect(result.legs).toEqual([{ channel: 'email', outcome: 'sent' }]);
    expect(sms.calls).toHaveLength(0);
    expect(ledger.map((r) => r.channel)).toEqual(['email']);
  });
});

// ── VIL-293 · the choke point's own honesty gate ─────────────────────────────

describe('a rendered body that claims something no row can back never reaches a provider', () => {
  /** A template that promises to change how Hale itself behaves — the 2026-08-12
   * sentence, in the one seam every loop message passes through. */
  const claiming = {
    render: () => ({
      kind: 'sms' as const,
      text: "Here's your week. I'll cut the one sec messages and just answer.",
    }),
  };

  it('refuses the leg, writes the row, and calls no adapter', async () => {
    const sms = fakeChannel('sms');
    const { ports, ledger } = makePorts({
      prefs: { loopChannel: 'sms' },
      renderer: claiming,
      channels: { sms },
    });
    const result = await dispatchLoopMessage(message(), ports);

    expect(result.legs).toEqual([
      { channel: 'sms', outcome: 'failed', reason: 'unbacked_claim' },
    ]);
    expect(sms.calls).toEqual([]);
    expect(ledger).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'unbacked_claim' }),
    ]);
  });

  it('leaves an ordinary template alone', async () => {
    const sms = fakeChannel('sms');
    const { ports } = makePorts({ prefs: { loopChannel: 'sms' }, channels: { sms } });
    const result = await dispatchLoopMessage(message(), ports);

    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(sms.calls).toHaveLength(1);
  });

});
