import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSmsChannel } from '~/lib/channel/adapters/phone-sms';
import { BUBBLE_GAP_MS } from '~/lib/channel/linq/bubble-gap';
import { LinqSendError, createLinqPhoneTransport } from '~/lib/channel/linq/transport';
import { DEFAULT_LOOP_PREFS, type LoopPrefsView } from '~/lib/loop/prefs';
import { CAREGIVER_REMINDER_TEMPLATE_KEY } from '~/lib/loop/templates/caregiver/keys';
import { SEND_RETRIES_EXHAUSTED } from './config';
import {
  ChannelRetryableError,
  type DispatchPorts,
  type LedgerWrite,
  PROACTIVE_FLOOR_HOLD,
  dispatchLoopMessage,
  recordAbandonedDispatch,
} from './dispatch';
import { fakeChannel, fakeRenderer } from './fakes';
import type { DispatchShadowInput } from './reconcile/claim-shadow';
import { claimsNoLedgerCanBack } from './reconcile/claims';
import type { LoopMessage, RenderedContent, VoiceOutcome } from './types';

/**
 * VIL-213 · A2 dispatch policy. Deterministic (no LLM) → plain Vitest with Fakes +
 * an injected clock. Proves the AC: policy is per delivery leg (the parent's
 * exchange channel), a ledger row per outcome (suppression OR send), per-channel
 * dedupe, time_sensitive bypass, and the email CASL dual-write.
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
  const audits: { actionTaken: string; after: Record<string, unknown> }[] = [];
  const captures: Capture[] = [];
  const threaded: { familyId: string; parentUserId: string; body: string }[] = [];
  const prefs: LoopPrefsView = { ...DEFAULT_LOOP_PREFS, ...(overrides.prefs ?? {}) };

  const ports: DispatchPorts = {
    now: () => NOON,
    loadPrefs: async () => prefs,
    loadParent: async () => ({ timezone: TORONTO }),
    parentPhone: async () => null,
    smsConsentLive: async () => true,
    activeDedupe: async () => false,
    chatService: async () => null,
    record: async (w) => {
      ledger.push(w);
      return `row-${ledger.length}`;
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
    channels: { sms: fakeChannel('sms') },
    renderer: fakeRenderer,
    claimShadow: { dispatch: () => 'off' },
    claimEnforce: { enforces: () => false, decide: async () => ({ status: 'off' as const }) },
    ...overrides,
  };
  return { ports, ledger, audits, captures, threaded };
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
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'suppressed_pref' }]);
    expect(ledger).toEqual([
      expect.objectContaining({ status: 'suppressed_pref', dedupeKey: null }),
    ]);
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
    expect(result.legs).toEqual([
      { channel: 'sms', outcome: 'suppressed_quiet_hours', reason: 'parent_window' },
    ]);
    expect(ledger).toEqual([
      expect.objectContaining({
        status: 'suppressed_quiet_hours',
        dedupeKey: null,
        errorCode: 'parent_window',
      }),
    ]);
  });

  it('time_sensitive bypasses quiet hours and sends (a non-reminder)', async () => {
    const emailChannel = fakeChannel('sms');
    const { ports, ledger } = makePorts({ now: () => NIGHT, channels: { sms: emailChannel } });
    const result = await dispatchLoopMessage(
      message({ category: 'alert', urgency: 'time_sensitive' }),
      ports,
    );
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(emailChannel.calls).toHaveLength(1);
    expect(ledger[0]?.status).toBe('queued');
  });

  it('sends a reminder with no per-category count in the way', async () => {
    const { ports, ledger } = makePorts();
    const result = await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(ledger[0]?.status).toBe('queued');
  });
});

/**
 * The proactive floor at SEND time. The run checks it before it enqueues; a retry or a
 * drain backlog can carry the send past 21:00, and the parent's own window (21:30 by
 * default, with the T-1h urgent bypass) would let it through. Denver in November is MST
 * (UTC-7); New York is EST (UTC-5).
 */
describe('the proactive floor holds a reminder at send', () => {
  const DENVER = 'America/Denver';
  const MST_2112 = new Date('2026-11-06T04:12:00Z'); // 21:12 MST, 5 Nov — before the 21:30 window
  const MST_2012 = new Date('2026-11-06T03:12:00Z'); // 20:12 MST, 5 Nov — the floor is open
  const MST_2200 = new Date('2026-11-06T05:00:00Z'); // 22:00 MST — inside floor AND window

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['time_sensitive', 'normal'] as const)(
    'holds a %s reminder at 21:12 local, named proactive_floor, with no send',
    async (urgency) => {
      const sms = fakeChannel('sms');
      const { ports, ledger } = makePorts({
        now: () => MST_2112,
        loadParent: async () => ({ timezone: DENVER }),
        channels: { sms },
      });
      const result = await dispatchLoopMessage(
        message({ urgency, dedupeKey: 'reminder:k' }),
        ports,
      );
      expect(result.legs).toEqual([
        { channel: 'sms', outcome: 'suppressed_quiet_hours', reason: PROACTIVE_FLOOR_HOLD },
      ]);
      expect(ledger).toEqual([
        expect.objectContaining({
          status: 'suppressed_quiet_hours',
          dedupeKey: null,
          errorCode: 'proactive_floor',
        }),
      ]);
      expect(sms.calls).toHaveLength(0);
    },
  );

  it('positive control: the same reminder at 20:12 local is sent', async () => {
    const sms = fakeChannel('sms');
    const { ports } = makePorts({
      now: () => MST_2012,
      loadParent: async () => ({ timezone: DENVER }),
      channels: { sms },
    });
    const result = await dispatchLoopMessage(message({ urgency: 'time_sensitive' }), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(sms.calls).toHaveLength(1);
  });

  it('a T-1h at 22:00 with the urgent bypass on still meets the floor', async () => {
    const sms = fakeChannel('sms');
    const { ports } = makePorts({
      now: () => MST_2200,
      loadParent: async () => ({ timezone: DENVER }),
      channels: { sms },
    });
    const result = await dispatchLoopMessage(message({ urgency: 'time_sensitive' }), ports);
    expect(result.legs).toEqual([
      { channel: 'sms', outcome: 'suppressed_quiet_hours', reason: 'proactive_floor' },
    ]);
    expect(sms.calls).toHaveLength(0);
  });

  it('the floor is the reminder class only: an approval at 21:12 local is sent', async () => {
    const sms = fakeChannel('sms');
    const { ports } = makePorts({
      now: () => MST_2112,
      loadParent: async () => ({ timezone: DENVER }),
      channels: { sms },
    });
    const result = await dispatchLoopMessage(message({ category: 'approval' }), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(sms.calls).toHaveLength(1);
  });

  describe('a Florida number while cadence is armed starts the floor at 20:00', () => {
    const EST_2030 = new Date('2026-11-06T01:30:00Z'); // 20:30 EST, 5 Nov

    function floridaPorts(phone: () => Promise<string | null>) {
      const sms = fakeChannel('sms');
      const made = makePorts({
        now: () => EST_2030,
        loadParent: async () => ({ timezone: 'America/New_York' }),
        parentPhone: phone,
        channels: { sms },
      });
      return { ...made, sms };
    }

    it('holds a Florida number at 20:30', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
      const { ports, sms } = floridaPorts(async () => '+13055550100');
      const result = await dispatchLoopMessage(message(), ports);
      expect(result.legs).toEqual([
        { channel: 'sms', outcome: 'suppressed_quiet_hours', reason: 'proactive_floor' },
      ]);
      expect(sms.calls).toHaveLength(0);
    });

    it('control: a New York number at the same instant is sent', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
      const { ports, sms } = floridaPorts(async () => '+12125550100');
      const result = await dispatchLoopMessage(message(), ports);
      expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
      expect(sms.calls).toHaveLength(1);
    });

    it('control: with cadence off the phone is never read', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'off');
      const { ports, sms } = floridaPorts(async () => {
        throw new Error('the phone must not be read while cadence is off');
      });
      const result = await dispatchLoopMessage(message(), ports);
      expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
      expect(sms.calls).toHaveLength(1);
    });
  });
});

describe('per-channel dedupe idempotency — a re-drain never double-sends', () => {
  it('skips the leg whose per-channel key is already sent, writing no row', async () => {
    const sentKeys = new Set(['fam-1:2026-W23:weekly:sms']); // email already went last drain
    const emailChannel = fakeChannel('sms');
    const { ports, ledger } = makePorts({
      activeDedupe: async (key) => sentKeys.has(key),
      channels: { sms: emailChannel },
    });
    const result = await dispatchLoopMessage(
      message({ category: 'reminder', dedupeKey: 'fam-1:2026-W23:weekly' }),
      ports,
    );
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'deduped' }]);
    expect(emailChannel.calls).toHaveLength(0); // not re-sent
    expect(ledger.filter((r) => r.channel === 'sms')).toHaveLength(0); // dedupe writes no row
  });
});

describe('email CASL dual-write + audit', () => {
  it("names a caregiver leg by WHO received it — the trail must not say 'Hale sent you a message'", async () => {
    // A caregiver's reminder is a DISCLOSURE of the household to a third party, and the verb
    // is how a PIPEDA read finds it later. Pinned here because the templateKey is the
    // only thing that distinguishes the two rows: with the branch collapsed back to
    // `channel_sent`, every other dispatch assertion stays green.
    const { ports, audits } = makePorts({ prefs: { loopChannel: 'sms' } });
    await dispatchLoopMessage(
      message({ templateKey: CAREGIVER_REMINDER_TEMPLATE_KEY, category: 'reminder' }),
      ports,
    );
    expect(audits).toEqual([
      {
        actionTaken: 'caregiver_schedule_sent',
        after: {
          channel: 'sms',
          category: 'reminder',
          templateKey: CAREGIVER_REMINDER_TEMPLATE_KEY,
        },
      },
    ]);
  });

  it('keeps the generic verb for the same category sent to a parent (positive control)', async () => {
    const { ports, audits } = makePorts({ prefs: { loopChannel: 'sms' } });
    await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(audits.map((a) => a.actionTaken)).toEqual(['channel_sent']);
  });
});

describe("the parent's own text thread", () => {
  it('threads a delivered SMS leg with the body that went on the wire', async () => {
    // A loop message is a thing Hale SAID, and the parent answers it by text.
    // `channel_messages` stores no body (rule #1), so this is the only record a coach
    // turn can read the reply against.
    const { ports, threaded } = makePorts({ prefs: { loopChannel: 'sms' } });
    await dispatchLoopMessage(message({ category: 'reminder' }), ports);

    expect(threaded).toEqual([
      { familyId: 'fam-1', parentUserId: 'user-1', body: 'weekly-plan-v1' },
    ]);
  });

  it('threads nothing when the SMS leg never reached the provider', async () => {
    // The positive control: same channel, same message, refused. A suppressed leg is
    // not something Hale said.
    const { ports, threaded } = makePorts({
      prefs: { loopChannel: 'sms' },
      smsConsentLive: async () => false,
    });
    const result = await dispatchLoopMessage(message({ category: 'reminder' }), ports);

    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'suppressed_consent' }]);
    expect(threaded).toEqual([]);
  });
});

describe('provider outcomes', () => {
  it('records a failed row on a permanent error', async () => {
    const { ports, ledger } = makePorts({
      channels: {
        sms: fakeChannel('sms', {
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
      { channel: 'sms', outcome: 'failed', reason: 'invalid_recipient' },
    ]);
    expect(ledger[0]).toMatchObject({ status: 'failed', errorCode: 'invalid_recipient' });
  });

  it('throws ChannelRetryableError on a transient error and writes no terminal row', async () => {
    const { ports, ledger } = makePorts({
      channels: {
        sms: fakeChannel('sms', {
          status: 'error',
          transient: true,
          code: 'rate_limited',
          message: 'try later',
        }),
      },
    });
    await expect(dispatchLoopMessage(message(), ports)).rejects.toBeInstanceOf(
      ChannelRetryableError,
    );
    expect(ledger).toHaveLength(0);
  });

  it('records the failed row for a permanent SMS refusal, through the real SMS adapter', async () => {
    // The branch above proves the policy with a fake; this proves the SMS leg can
    // actually reach it. It could not before: the transport threw a bare string error,
    // the adapter had no error variant, and every permanent refusal came out of the
    // dispatch as a throw — a retry loop against a parent who had opted out.
    const { ports, ledger, captures } = makePorts({
      prefs: { loopChannel: 'sms' },
      channels: {
        sms: createSmsChannel({
          transport: {
            async send(): Promise<{ providerMessageId: string }> {
              throw new LinqSendError('21610', 400, true);
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
      { channel: 'sms', outcome: 'failed', reason: 'channel_unavailable' },
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
        properties: {
          channel: 'sms',
          category: 'reminder',
          templateKey: 'weekly-plan-v1',
          reason: 'suppressed_pref',
        },
      },
    ]);
  });

  it('a real send writes one ledger row and one loop_message_sent capture, reason = sent', async () => {
    const { ports, ledger, captures } = makePorts();
    await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(captures).toHaveLength(ledger.length);
    expect(captures).toEqual([
      {
        event: 'loop_message_sent',
        distinctId: 'user-1',
        properties: {
          channel: 'sms',
          category: 'reminder',
          templateKey: 'weekly-plan-v1',
          reason: 'queued',
        },
      },
    ]);
  });

  /**
   * The SMS leg's row is born 'queued' — the provider accepted it, the carrier has not
   * confirmed it (channel/ledger.ts acceptedStatus). The capture must NOT follow the
   * status blindly: a queued SMS is a SEND, and pairing it with loop_message_failed
   * would report every text Hale sends as a failure.
   */
  it('an sms leg is ledgered queued, and still captured as a send', async () => {
    const { ports, ledger, captures } = makePorts({
      prefs: { loopChannel: 'sms' },
      channels: { sms: fakeChannel('sms') },
    });

    const result = await dispatchLoopMessage(message({ category: 'reminder' }), ports);

    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(ledger[0]).toMatchObject({ channel: 'sms', status: 'queued' });
    expect(captures[0]).toMatchObject({
      event: 'loop_message_sent',
      properties: { channel: 'sms', reason: 'queued' },
    });
  });

  it('a permanent provider error writes one ledger row and one loop_message_failed capture', async () => {
    const { ports, ledger, captures } = makePorts({
      channels: {
        sms: fakeChannel('sms', {
          status: 'error',
          transient: false,
          code: 'invalid_recipient',
          message: 'bad',
        }),
      },
    });
    await dispatchLoopMessage(message(), ports);
    expect(captures).toHaveLength(ledger.length);
    expect(captures[0]).toMatchObject({
      event: 'loop_message_failed',
      properties: { reason: 'failed' },
    });
  });

  it('a suppressed leg fires its paired capture, one per row', async () => {
    const { ports, ledger, captures } = makePorts({ smsConsentLive: async () => false });
    await dispatchLoopMessage(message({ category: 'reminder' }), ports);
    expect(captures).toHaveLength(ledger.length);
    expect(captures.map((c) => `${c.properties.channel}:${c.event}`)).toEqual([
      'sms:loop_message_failed',
    ]);
  });

  it('a deduped leg writes NEITHER a ledger row nor a capture (no row ⇒ no event)', async () => {
    const { ports, ledger, captures } = makePorts({ activeDedupe: async () => true });
    const result = await dispatchLoopMessage(message({ dedupeKey: 'fam-1:key' }), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'deduped' }]);
    expect(ledger).toHaveLength(0);
    expect(captures).toHaveLength(0);
  });

  it('a transient (retryable) error writes no terminal row and fires no capture', async () => {
    const { ports, ledger, captures } = makePorts({
      channels: {
        sms: fakeChannel('sms', {
          status: 'error',
          transient: true,
          code: 'rate_limited',
          message: 'later',
        }),
      },
    });
    await expect(dispatchLoopMessage(message(), ports)).rejects.toBeInstanceOf(
      ChannelRetryableError,
    );
    expect(ledger).toHaveLength(0);
    expect(captures).toHaveLength(0);
  });
});

/**
 * SMS reliability audit P0-3, the rule-#11 half: a `channel.send` job that spends every
 * retry (transient provider errors all the way down the backoff arc) previously vanished
 * into pg-boss's failed state with NO ledger row — the drain's dead-letter consumer now
 * records the abandonment here, so it is a countable `failed` row, not three log lines.
 */
describe('recordAbandonedDispatch — the channel.send dead-letter outcome', () => {
  it('writes a failed ledger row named send_retries_exhausted on the exchange channel', async () => {
    const { ports, ledger } = makePorts({ prefs: { loopChannel: 'sms' } });

    const result = await recordAbandonedDispatch(message(), ports);

    expect(result.legs).toEqual([
      { channel: 'sms', outcome: 'failed', reason: SEND_RETRIES_EXHAUSTED },
    ]);
    expect(ledger).toEqual([
      expect.objectContaining({
        status: 'failed',
        channel: 'sms',
        errorCode: SEND_RETRIES_EXHAUSTED,
        dedupeKey: null,
      }),
    ]);
  });

  it('records on the PINNED channel when the message rides one', async () => {
    const { ports, ledger } = makePorts({ prefs: { loopChannel: 'sms' } });

    await recordAbandonedDispatch(message({ channel: 'sms' }), ports);

    expect(ledger[0]?.channel).toBe('sms');
  });

  it('fires the paired loop_message_failed analytics event and touches no adapter', async () => {
    const sms = fakeChannel('sms');
    const { ports, captures } = makePorts({ prefs: { loopChannel: 'sms' }, channels: { sms } });

    await recordAbandonedDispatch(message(), ports);

    expect(sms.calls).toEqual([]);
    expect(captures).toEqual([
      expect.objectContaining({
        event: 'loop_message_failed',
        properties: expect.objectContaining({ reason: 'failed' }),
      }),
    ]);
  });
});

/**
 * THE VOICE OUTCOME, CARRIED OUT OF THE RENDER (docs/voice.md, "The two SMS folds").
 *
 * Two templates compose a sentence through a model and then measure it against the wire.
 * Whether a parent READ that sentence is decided here and nowhere earlier — the composer
 * ran hours before, at the converge tick, without knowing which channel the family is on
 * — so a renderer that kept the answer to itself would make "the composer degraded", "the
 * fold refused it" and "it went out" one silence (rule #11).
 *
 * The drain discards the DispatchResult, so the LEG is where a test can read the outcome
 * and the immutable audit row is where production can. Both, or it is not counted.
 */
describe('the composed voice slot is reported off the render, never inferred from the body', () => {
  const voicedRenderer = (voice: VoiceOutcome | undefined) => ({
    render: (m: LoopMessage): RenderedContent => ({
      kind: 'sms' as const,
      text: m.templateKey,
      modelWritten: false,
      voice,
    }),
  });

  it('carries each outcome onto the leg AND onto the immutable audit row', async () => {
    for (const outcome of [
      'used',
      'absent',
      'refused:gsm_dropped',
      'refused:question_count',
      'refused:over_segment',
    ] as const) {
      const { ports, audits } = makePorts({
        prefs: { loopChannel: 'sms' },
        renderer: voicedRenderer(outcome),
      });
      const result = await dispatchLoopMessage(message(), ports);
      expect(result.legs, outcome).toEqual([{ channel: 'sms', outcome: 'sent', voice: outcome }]);
      // An enum about Hale's own pipeline, never content — which is what makes it safe on
      // a PIPEDA-exportable row, and this is the only DURABLE count there is.
      expect(audits[0]?.after, outcome).toEqual({
        channel: 'sms',
        category: 'reminder',
        templateKey: 'weekly-plan-v1',
        voice: outcome,
      });
    }
  });

  it('says nothing at all for a template that has no voice slot — not "absent"', async () => {
    // A template with no composed sentence to begin with is a different fact from a
    // composer that degraded, and 'absent' means the second one.
    const { ports, audits } = makePorts({ prefs: { loopChannel: 'sms' } });
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.legs[0]?.voice).toBeUndefined();
    // Serialized into the jsonb row, an undefined key is no key at all — the row says
    // nothing about a voice, which is the fact.
    expect(audits[0]?.after.voice).toBeUndefined();
    expect(JSON.parse(JSON.stringify(audits[0]?.after))).toEqual({
      channel: 'sms',
      category: 'reminder',
      templateKey: 'weekly-plan-v1',
    });
  });

  it('still names the outcome on a leg the PROVIDER refused', async () => {
    // "The fold refused the sentence" and "the provider refused the message" are two
    // different things to be looking at, and a failed leg that dropped the first would
    // make a composer bug invisible behind a delivery one.
    const { ports } = makePorts({
      prefs: { loopChannel: 'sms' },
      renderer: voicedRenderer('refused:question_count'),
      channels: { sms: fakeChannel('sms', { status: 'skipped', reason: 'not_configured' }) },
    });
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.legs).toEqual([
      {
        channel: 'sms',
        outcome: 'failed',
        reason: 'not_configured',
        voice: 'refused:question_count',
      },
    ]);
  });
});

describe('VIL-467 · multi-text legs — in order, one row per text, retry sends only the unsent', () => {
  const TEXTS = [
    'hey, heads up for tomorrow',
    'tour at 10, about an hour',
    'storytime 1:30 to 2:15',
  ];
  const multiRenderer = {
    render: (): RenderedContent => ({
      kind: 'sms',
      text: TEXTS.join('\n\n'),
      texts: [...TEXTS],
      modelWritten: true,
      recordBody: true,
    }),
  };

  function scriptedChannel(script: Array<'sent' | 'transient' | 'permanent'>) {
    const calls: string[] = [];
    let n = 0;
    return {
      calls,
      channel: {
        kind: 'sms' as const,
        async send(input: { userId: string; rendered: RenderedContent }) {
          const step = script[n] ?? 'sent';
          n += 1;
          if (step === 'transient') {
            return { status: 'error' as const, transient: true, code: 'timeout', message: 'x' };
          }
          if (step === 'permanent') {
            return { status: 'error' as const, transient: false, code: 'blocked', message: 'x' };
          }
          calls.push(input.rendered.text);
          return {
            status: 'sent' as const,
            providerMessageId: `m-${calls.length}`,
            transport: 'sms' as const,
          };
        },
      },
    };
  }

  it('sends each text in order, one ledger row and one thread entry per text, keys :i', async () => {
    const sms = scriptedChannel([]);
    const { ports, ledger, threaded, audits } = makePorts({
      renderer: multiRenderer,
      channels: { sms: sms.channel },
    });
    const result = await dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(sms.calls).toEqual(TEXTS);
    expect(ledger.map((r) => [r.dedupeKey, r.body, r.status])).toEqual([
      ['reminder:k:sms:0', TEXTS[0], 'queued'],
      ['reminder:k:sms:1', TEXTS[1], 'queued'],
      ['reminder:k:sms:2', TEXTS[2], 'queued'],
    ]);
    expect(threaded.map((t) => t.body)).toEqual(TEXTS);
    expect(audits).toHaveLength(3);
  });

  it('checks quiet hours once for the whole set and sends none of it', async () => {
    const sms = scriptedChannel([]);
    const { ports, ledger } = makePorts({
      now: () => NIGHT,
      renderer: multiRenderer,
      channels: { sms: sms.channel },
    });
    const result = await dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports);
    expect(result.legs).toEqual([
      { channel: 'sms', outcome: 'suppressed_quiet_hours', reason: 'parent_window' },
    ]);
    expect(sms.calls).toHaveLength(0);
    expect(ledger).toHaveLength(1);
  });

  it('a transient failure mid-set rethrows; the retry sends only the unsent texts', async () => {
    const sent = new Set<string>();
    const sms = scriptedChannel(['sent', 'transient']);
    const { ports, ledger } = makePorts({
      renderer: multiRenderer,
      channels: { sms: sms.channel },
      activeDedupe: async (key) => sent.has(key),
      record: async (w) => {
        ledger.push(w);
        if (w.dedupeKey) sent.add(w.dedupeKey);
        return `row-${ledger.length}`;
      },
    });
    await expect(
      dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports),
    ).rejects.toBeInstanceOf(ChannelRetryableError);
    expect(sms.calls).toEqual([TEXTS[0]]);
    const retry = await dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports);
    expect(retry.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(sms.calls).toEqual(TEXTS); // text 0 once, then 1 and 2
    expect(ledger.map((r) => r.dedupeKey)).toEqual([
      'reminder:k:sms:0',
      'reminder:k:sms:1',
      'reminder:k:sms:2',
    ]);
  });

  it('a permanent refusal stops the set with one failed row and no fallback text', async () => {
    const sms = scriptedChannel(['sent', 'permanent']);
    const { ports, ledger, threaded } = makePorts({
      renderer: multiRenderer,
      channels: { sms: sms.channel },
    });
    const result = await dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'failed', reason: 'blocked' }]);
    expect(sms.calls).toEqual([TEXTS[0]]);
    expect(threaded.map((t) => t.body)).toEqual([TEXTS[0]]);
    expect(ledger.map((r) => r.status)).toEqual(['queued', 'failed']);
  });

  it('a fully re-drained set is deduped and sends nothing', async () => {
    const sms = scriptedChannel([]);
    const { ports, ledger } = makePorts({
      renderer: multiRenderer,
      channels: { sms: sms.channel },
      activeDedupe: async () => true,
    });
    const result = await dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'deduped' }]);
    expect(sms.calls).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });

  it('VIL-474 · bolds by position: of two identical texts only the first carries the bold', async () => {
    const SAME = 'swim moved to 4:30';
    const boldRenderer = {
      render: (): RenderedContent => ({
        kind: 'sms',
        text: [SAME, 'see you there', SAME].join('\n\n'),
        texts: [SAME, 'see you there', SAME],
        modelWritten: true,
        recordBody: true,
        bold: '4:30',
      }),
    };
    const seen: Array<{ text: string; bold: string | undefined }> = [];
    const channel = {
      kind: 'sms' as const,
      async send(input: { userId: string; rendered: RenderedContent }) {
        const r = input.rendered as RenderedContent & { bold?: string };
        seen.push({ text: r.text, bold: r.bold });
        return {
          status: 'sent' as const,
          providerMessageId: `m-${seen.length}`,
          transport: 'sms' as const,
        };
      },
    };
    const { ports } = makePorts({ renderer: boldRenderer, channels: { sms: channel } });
    const result = await dispatchLoopMessage(message({ dedupeKey: 'reminder:b' }), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(seen).toEqual([
      { text: SAME, bold: '4:30' },
      { text: 'see you there', bold: undefined },
      { text: SAME, bold: undefined },
    ]);
  });

  /** A channel whose texts land in one Linq chat on `transport`, stamped with the clock. */
  function stampedChannel(transport: 'imessage' | 'sms') {
    const sends: Array<[number, string]> = [];
    return {
      sends,
      channel: {
        kind: 'sms' as const,
        async send(input: { userId: string; rendered: RenderedContent }) {
          sends.push([Date.now(), input.rendered.text]);
          return {
            status: 'sent' as const,
            providerMessageId: `m-${sends.length}`,
            transport,
            providerChatId: 'chat-1',
          };
        },
      },
    };
  }

  describe('VIL-682 K5 · paced between bubbles', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it('lit, a set that went into a chat Linq said is iMessage waits about two seconds before each later text', async () => {
      vi.useFakeTimers();
      vi.stubEnv('COACH_BUBBLES_ENABLED', 'true');
      const im = stampedChannel('imessage');
      const asked: Array<[string, string]> = [];
      const { ports, ledger } = makePorts({
        renderer: multiRenderer,
        channels: { sms: im.channel },
        chatService: async (parentUserId, chatId) => {
          asked.push([parentUserId, chatId]);
          return 'iMessage';
        },
      });
      const start = Date.now();

      const result = dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports);
      await vi.advanceTimersByTimeAsync(2 * BUBBLE_GAP_MS);

      expect((await result).legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
      expect(im.sends).toEqual([
        [start, TEXTS[0]],
        [start + 2_000, TEXTS[1]],
        [start + 4_000, TEXTS[2]],
      ]);
      expect(ledger.map((r) => r.dedupeKey)).toEqual([
        'reminder:k:sms:0',
        'reminder:k:sms:1',
        'reminder:k:sms:2',
      ]);
      // Asked once per set, about the chat the first text landed in.
      expect(asked).toEqual([['user-1', 'chat-1']]);
    });

    // Linq reports `imessage` for every chat on its line, green-bubble SMS and RCS chats
    // included, so only the service Linq said carried the parent's texts there decides.
    it.each([
      ['dark, on iMessage', 'false', 'imessage', 'iMessage'],
      ['lit, but the set went as SMS', 'true', 'sms', null],
      ['lit, Linq transport, but Linq said the chat is SMS', 'true', 'imessage', 'SMS'],
      ['lit, Linq transport, but Linq said the chat is RCS', 'true', 'imessage', 'RCS'],
      ['lit, Linq transport, and Linq never said', 'true', 'imessage', null],
    ] as const)('%s: the texts go back to back', async (_label, flag, transport, service) => {
      vi.useFakeTimers();
      vi.stubEnv('COACH_BUBBLES_ENABLED', flag);
      const ch = stampedChannel(transport);
      const { ports } = makePorts({
        renderer: multiRenderer,
        channels: { sms: ch.channel },
        chatService: async () => service,
      });
      const start = Date.now();

      const result = dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports);
      await vi.advanceTimersByTimeAsync(2 * BUBBLE_GAP_MS);

      expect((await result).legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
      expect(ch.sends).toEqual(TEXTS.map((text) => [start, text]));
    });

    // The read only decides the pacing: one that fails costs the gaps, never a text.
    it('lit, a chat service read that fails: every text still goes, back to back, and the miss is named', async () => {
      vi.useFakeTimers();
      vi.stubEnv('COACH_BUBBLES_ENABLED', 'true');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const im = stampedChannel('imessage');
      const { ports, ledger } = makePorts({
        renderer: multiRenderer,
        channels: { sms: im.channel },
        chatService: async () => {
          throw new Error('connection reset');
        },
      });
      const start = Date.now();

      const result = dispatchLoopMessage(message({ dedupeKey: 'reminder:k' }), ports);
      await vi.advanceTimersByTimeAsync(2 * BUBBLE_GAP_MS);

      expect((await result).legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
      expect(im.sends).toEqual(TEXTS.map((text) => [start, text]));
      expect(ledger).toHaveLength(TEXTS.length);
      expect(
        warn.mock.calls.flatMap(([fields]) =>
          fields && typeof fields === 'object' && 'outcome' in fields ? [fields.outcome] : [],
        ),
      ).toEqual(['pacing_read_failed']);
      warn.mockRestore();
    });
  });
});

describe('VIL-581 · the claim shadow reads model-written bodies only, and the leg is unchanged', () => {
  const MODEL_BODY = 'Swim is at 10 on Saturday.';
  function shadowPorts(modelWritten: boolean, text = MODEL_BODY) {
    const shadowed: DispatchShadowInput[] = [];
    const run = makePorts({
      renderer: { render: () => ({ kind: 'sms', text, modelWritten }) },
      claimShadow: {
        dispatch: (input) => {
          shadowed.push(input);
          return 'started';
        },
      },
    });
    return { ...run, shadowed };
  }

  it('a model-written body is handed over once, with its own claims and no zone', async () => {
    const { ports, shadowed } = shadowPorts(true);
    const result = await dispatchLoopMessage(message(), ports);
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]).toEqual({
      familyId: 'fam-1',
      parentUserId: 'user-1',
      body: MODEL_BODY,
      now: NOON,
      claims: claimsNoLedgerCanBack(MODEL_BODY),
    });
    expect('timeZone' in (shadowed[0] as object)).toBe(false);
    const baseline = await dispatchLoopMessage(
      message(),
      makePorts({
        renderer: { render: () => ({ kind: 'sms', text: MODEL_BODY, modelWritten: true }) },
      }).ports,
    );
    expect(result).toEqual(baseline);
  });

  it('a template body is never handed over (control)', async () => {
    const { ports, shadowed } = shadowPorts(false);
    expect((await dispatchLoopMessage(message(), ports)).legs[0]?.outcome).toBe('sent');
    expect(shadowed).toEqual([]);
  });

  it('an unbacked model-written body is refused exactly as before, and the shadow saw the claim', async () => {
    const { ports, shadowed, ledger } = shadowPorts(
      true,
      "I'll stop sending the one-sec messages.",
    );
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'failed', reason: 'unbacked_claim' }]);
    expect(ledger.map((w) => [w.status, w.errorCode])).toEqual([['failed', 'unbacked_claim']]);
    expect(shadowed[0]?.claims.map((c) => c.kind)).toEqual(['self_referential']);
  });
});

describe('VIL-581 · enforce at the dispatch choke reads model-written bodies only', () => {
  const MODEL_BODY = 'Votre visite chez le dentiste est réservée.';

  function enforcePorts(
    decision: Awaited<ReturnType<DispatchPorts['claimEnforce']['decide']>>,
    modelWritten: boolean,
    text = MODEL_BODY,
  ) {
    const decided: unknown[] = [];
    const shadowed: DispatchShadowInput[] = [];
    const run = makePorts({
      renderer: { render: () => ({ kind: 'sms', text, modelWritten }) },
      claimShadow: {
        dispatch: (input) => {
          shadowed.push(input);
          return 'started';
        },
      },
      claimEnforce: {
        enforces: () => true,
        decide: async (input) => {
          decided.push(input);
          return decision;
        },
      },
    });
    return { ...run, decided, shadowed };
  }

  it('a clean read sends, and the shadow is not started', async () => {
    const { ports, decided, shadowed } = enforcePorts({ status: 'clean' }, true);
    expect((await dispatchLoopMessage(message(), ports)).legs[0]?.outcome).toBe('sent');
    expect(decided).toHaveLength(1);
    expect(shadowed).toEqual([]);
  });

  it('a template body is never read (control)', async () => {
    const { ports, decided, shadowed } = enforcePorts({ status: 'clean' }, false);
    expect((await dispatchLoopMessage(message(), ports)).legs[0]?.outcome).toBe('sent');
    expect(decided).toEqual([]);
    expect(shadowed).toEqual([]);
  });

  it('an unbacked read fails the leg the same way the regex floor does', async () => {
    const { ports, ledger, shadowed } = enforcePorts({ status: 'unbacked' }, true);
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'failed', reason: 'unbacked_claim' }]);
    expect(ledger.map((w) => [w.status, w.errorCode])).toEqual([['failed', 'unbacked_claim']]);
    expect(shadowed).toEqual([]);
  });

  it('a retryable read failure throws ChannelRetryableError and writes no row', async () => {
    const { ports, ledger } = enforcePorts(
      { status: 'failed', reason: 'unreachable', retry: true },
      true,
    );
    await expect(dispatchLoopMessage(message(), ports)).rejects.toBeInstanceOf(
      ChannelRetryableError,
    );
    expect(ledger).toEqual([]);
  });

  it('a non-retryable read failure fails the leg as claim_read_failed', async () => {
    const { ports, ledger } = enforcePorts(
      { status: 'failed', reason: 'oversize', retry: false },
      true,
    );
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.legs).toEqual([
      { channel: 'sms', outcome: 'failed', reason: 'claim_read_failed' },
    ]);
    expect(ledger.map((w) => [w.status, w.errorCode])).toEqual([['failed', 'claim_read_failed']]);
  });

  it('the regex floor still refuses without spending a read', async () => {
    const { ports, decided, ledger } = enforcePorts(
      { status: 'clean' },
      true,
      "I'll stop sending the one-sec messages.",
    );
    const result = await dispatchLoopMessage(message(), ports);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'failed', reason: 'unbacked_claim' }]);
    expect(decided).toEqual([]);
    expect(ledger.map((w) => w.errorCode)).toEqual(['unbacked_claim']);
  });
});

describe("VIL-581 · each renderer says whether its words are the model's", () => {
  it('reminder, calendar invite and calendar cancel are model-written', async () => {
    const { renderReminderSms } = await import('~/lib/loop/templates/reminder/sms');
    const { calendarInviteSmsRenderer } = await import('~/lib/loop/templates/calendar-invite/sms');
    const { calendarCancelSmsRenderer } = await import('~/lib/loop/templates/calendar-cancel/sms');
    const reminder = renderReminderSms({ texts: ['Swim at 10.'] } as unknown as Parameters<
      typeof renderReminderSms
    >[0]);
    const url = 'https://app.example.org/i/abc';
    const invite = calendarInviteSmsRenderer.render(
      message({ payload: { summary: 'Swim', when: 'Sat 10:00', url, line: `Add swim: ${url}` } }),
      'sms',
      'generic',
    );
    const cancel = calendarCancelSmsRenderer.render(
      message({ payload: { summary: 'Swim', when: 'Sat 10:00', line: 'Swim is off.' } }),
      'sms',
      'generic',
    );
    expect([reminder.modelWritten, invite.modelWritten, cancel.modelWritten]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('the caregiver reminder and the default renderer are not (control)', async () => {
    const { renderCaregiverReminderSms } = await import(
      '~/lib/loop/templates/caregiver/reminder-sms'
    );
    const { defaultLoopRenderer } = await import('./renderer');
    const caregiver = renderCaregiverReminderSms({
      offset: '-PT1H',
      timeZone: 'America/Denver',
      events: [{ eventRef: 'e1', title: 'Swim', startsAt: '2026-11-07T17:00:00Z', location: null }],
    } as unknown as Parameters<typeof renderCaregiverReminderSms>[0]);
    const plain = defaultLoopRenderer.render(
      message({ payload: { text: 'Hello.' } }),
      'sms',
      'generic',
    );
    expect([caregiver.modelWritten, plain.modelWritten]).toEqual([false, false]);
  });
});

describe('VIL-581 · the production dispatch port is bound and does nothing while off', () => {
  it('buildDispatchPorts wires a claim shadow that answers off under the kill switch, with no query', async () => {
    const { buildDispatchPorts } = await import('./wiring');
    vi.stubEnv('CLAIM_READER_MODE', 'off');
    try {
      const noQueries = new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('the shadow queried the database while off');
          },
        },
      ) as unknown as Parameters<typeof buildDispatchPorts>[0];
      const ports = buildDispatchPorts(noQueries, { channels: {}, renderer: fakeRenderer });
      expect(
        ports.claimShadow.dispatch({
          familyId: 'fam-1',
          parentUserId: 'user-1',
          body: MODEL_BODY_FOR_WIRING,
          now: NOON,
          claims: [],
        }),
      ).toBe('off');
      expect(ports.claimEnforce.enforces('fam-1')).toBe(false);
      await expect(
        ports.claimEnforce.decide({
          familyId: 'fam-1',
          parentUserId: 'user-1',
          body: MODEL_BODY_FOR_WIRING,
          now: NOON,
        }),
      ).resolves.toEqual({ status: 'off' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

const MODEL_BODY_FOR_WIRING = 'Swim is at 10 on Saturday.';

/**
 * VIL-683 · a loop text the send seam refuses as garbled. The refusal comes from the REAL
 * Linq door under the real SMS adapter (fetch spied). Its writer was already asked once
 * more, so nothing is sent, nothing stands in, and the family's audit trail names it.
 */
describe('a garbled loop text sends nothing and is on the audit trail', () => {
  const GARBLED = 'Natation prรฉscolaire sam. 9h00';

  function realSms() {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+14165550100');
    const fetchSpy = vi.fn(async () =>
      Response.json({ chat: { id: 'chat-1', message: { id: 'msg-1' } } }, { status: 201 }),
    );
    const sms = createSmsChannel({
      transport: createLinqPhoneTransport({ fetch: fetchSpy as typeof fetch }),
      resolveTarget: async () => '+14165550101',
      configured: true,
    });
    return { fetchSpy, sms };
  }

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['one text', { kind: 'sms', text: GARBLED, modelWritten: true }],
    [
      'a set of texts',
      { kind: 'sms', text: GARBLED, texts: [GARBLED, 'Swim is Saturday.'], modelWritten: true },
    ],
  ] satisfies [string, RenderedContent][])('%s', async (_name, rendered) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchSpy, sms } = realSms();
    const { ports, ledger, audits } = makePorts({
      prefs: { loopChannel: 'sms' },
      channels: { sms },
      renderer: { render: () => rendered },
    });

    const result = await dispatchLoopMessage(message(), ports);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.legs).toEqual([
      expect.objectContaining({ channel: 'sms', outcome: 'failed', reason: 'garbled_text' }),
    ]);
    expect(ledger).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'garbled_text' }),
    ]);
    expect(audits).toEqual([
      {
        actionTaken: 'channel_text_garbled',
        after: { channel: 'sms', category: 'reminder', templateKey: 'weekly-plan-v1' },
      },
    ]);
  });

  it('the same text spelled right is sent (positive control)', async () => {
    const { fetchSpy, sms } = realSms();
    const { ports, audits } = makePorts({
      prefs: { loopChannel: 'sms' },
      channels: { sms },
      renderer: {
        render: () => ({ kind: 'sms', text: 'Natation préscolaire sam. 9h00', modelWritten: true }),
      },
    });

    await dispatchLoopMessage(message(), ports);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(audits.map((a) => a.actionTaken)).toEqual(['channel_sent']);
  });
});
