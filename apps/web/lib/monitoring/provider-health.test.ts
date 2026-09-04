import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, HAIKU_MODEL } from '@hale/agent';
import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_INCIDENT_WINDOW_HOURS,
  type ProviderFailureClass,
  type ProviderHealthDeps,
  type ProviderIncident,
  abortsSendWindow,
  claimProviderIncident,
  classifyProviderFailure,
  createProviderAlertSender,
  formatProviderAlert,
  probeProviderHealth,
  providerIncidentKey,
  providerPreflight,
  raiseProviderIncident,
} from './provider-health';

/**
 * VIL-255 · the provider-health pre-flight. Errors here are built with the REAL SDK
 * factory (`Anthropic.APIError.generate`), not hand-rolled objects, so the classifier
 * is tested against the shapes the SDK actually throws — the incident that motivated
 * this ticket was a 400 whose billing reason only lives inside the response body.
 */

/** Build the error the SDK would throw for a given status + Anthropic error body. */
function apiError(status: number, type: string, message: string): unknown {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message } },
    undefined,
    { 'request-id': 'req_probe' },
  );
}

const CREDIT_EXHAUSTED = apiError(
  400,
  'invalid_request_error',
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
);

describe('classifyProviderFailure — the failure table', () => {
  const table: Array<{ name: string; err: unknown; expected: ProviderFailureClass }> = [
    { name: 'credit balance exhausted (400)', err: CREDIT_EXHAUSTED, expected: 'billing' },
    {
      name: 'explicit payment required (402)',
      err: apiError(402, 'invalid_request_error', 'Payment required'),
      expected: 'billing',
    },
    {
      name: 'invalid api key (401)',
      err: apiError(401, 'authentication_error', 'invalid x-api-key'),
      expected: 'auth',
    },
    {
      name: 'permission denied (403)',
      err: apiError(403, 'permission_error', 'Your API key does not have permission'),
      expected: 'auth',
    },
    {
      name: 'rate limited (429)',
      err: apiError(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit'),
      expected: 'quota',
    },
    {
      name: 'overloaded (529)',
      err: apiError(529, 'overloaded_error', 'Overloaded'),
      expected: 'transient',
    },
    {
      name: 'internal server error (500)',
      err: apiError(500, 'api_error', 'Internal server error'),
      expected: 'transient',
    },
    {
      name: 'connection error (no status)',
      err: new Anthropic.APIConnectionError({ message: 'Connection error.' }),
      expected: 'transient',
    },
    {
      name: 'a non-billing 400 — a malformed request is OUR bug, never a reason to abort',
      err: apiError(400, 'invalid_request_error', 'max_tokens: must be greater than 0'),
      expected: 'transient',
    },
    {
      name: 'an error that is not an SDK error at all',
      err: new TypeError('client.messages is not a function'),
      expected: 'transient',
    },
  ];

  for (const row of table) {
    it(`classifies ${row.name} as '${row.expected}'`, () => {
      expect(classifyProviderFailure(row.err)).toBe(row.expected);
    });
  }
});

describe('abortsSendWindow', () => {
  it('aborts on billing and auth only — quota and transient must let the window run', () => {
    expect(abortsSendWindow('billing')).toBe(true);
    expect(abortsSendWindow('auth')).toBe(true);
    expect(abortsSendWindow('quota')).toBe(false);
    expect(abortsSendWindow('transient')).toBe(false);
  });
});

describe('probeProviderHealth', () => {
  it('spends one token on the cheapest model and reports healthy', async () => {
    const create = vi.fn(async (_params: { model: string; max_tokens: number }) => ({
      id: 'msg_1',
      content: [],
    }));
    const client = { messages: { create } } as unknown as AgentClient;

    expect(await probeProviderHealth(client)).toEqual({ ok: true });

    const payload = create.mock.calls[0]?.[0];
    expect(payload?.model).toBe(HAIKU_MODEL);
    expect(payload?.max_tokens).toBe(1);
  });

  it('reports the failure class and a provider detail on a credit-balance 400', async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw CREDIT_EXHAUSTED;
        }),
      },
    } as unknown as AgentClient;

    const health = await probeProviderHealth(client);

    expect(health.ok).toBe(false);
    if (health.ok) return;
    expect(health.failure).toBe('billing');
    expect(health.detail).toContain('credit balance is too low');
  });
});

describe('providerIncidentKey', () => {
  it('keys one incident per failure class, and the run spike separately', () => {
    const billing = providerIncidentKey({
      kind: 'preflight',
      window: 'nudge_sweep',
      failure: 'billing',
      detail: 'x',
    });
    // The same billing outage seen from a DIFFERENT window is the SAME incident —
    // the founder gets one email, not one per cron.
    const billingFromWeekly = providerIncidentKey({
      kind: 'preflight',
      window: 'weekly_plan',
      failure: 'billing',
      detail: 'y',
    });
    const auth = providerIncidentKey({
      kind: 'preflight',
      window: 'nudge_sweep',
      failure: 'auth',
      detail: 'x',
    });
    const spike = providerIncidentKey({
      kind: 'run_spike',
      failed: 8,
      total: 8,
      windowStart: new Date('2026-08-01T12:00:00Z'),
      windowEnd: new Date('2026-08-01T13:00:00Z'),
    });

    expect(billing).toBe(billingFromWeekly);
    expect(new Set([billing, auth, spike]).size).toBe(3);
  });

  it('keys a failed digest send per DIGEST — one dead surface must not silence another', () => {
    const papercut = providerIncidentKey({
      kind: 'digest_send_failed',
      digest: 'papercut',
      reason: 'provider_error',
    });
    const loopHealth = providerIncidentKey({
      kind: 'digest_send_failed',
      digest: 'loop_health',
      reason: 'provider_error',
    });
    const triage = providerIncidentKey({
      kind: 'digest_send_failed',
      digest: 'twilio_triage',
      reason: 'provider_error',
    });

    expect(papercut).toBe('provider_health:digest_send_failed:papercut');
    expect(new Set([papercut, loopHealth, triage]).size).toBe(3);
  });
});

describe('formatProviderAlert', () => {
  const AT = new Date('2026-08-01T12:00:00Z');

  it('leads with what did not happen, then why, then what to do', () => {
    const { subject, text } = formatProviderAlert(
      {
        kind: 'preflight',
        window: 'weekly_plan',
        failure: 'billing',
        detail: 'Your credit balance is too low to access the Anthropic API.',
      },
      AT,
    );

    expect(subject).toBe('Hale ops: weekly plan did not send — Anthropic billing');
    expect(text).toContain("this hour's weekly-plan compose did not run.");
    expect(text).toContain('credit balance is too low');
    expect(text).toContain('2026-08-01T12:00:00.000Z');
    // The honest part: nothing was composed and nothing was charged.
    expect(text).toContain('before composing anything');
    expect(text).toContain('Plans & Billing');
    // Rule #1: an ops alert names windows and counts, never a family or a child.
    expect(text).not.toMatch(/famil(y|ies) [0-9a-f]{8}/i);
  });

  it('reports the run-failure backstop with the real counts', () => {
    const { subject, text } = formatProviderAlert(
      {
        kind: 'run_spike',
        failed: 7,
        total: 8,
        windowStart: new Date('2026-08-01T12:00:00Z'),
        windowEnd: new Date('2026-08-01T13:00:00Z'),
      },
      AT,
    );

    expect(subject).toBe('Hale ops: 7 of 8 agent runs failed in the last hour');
    expect(text).toContain('7 of 8');
    expect(text).toContain('2026-08-01T12:00:00.000Z');
    expect(text).toContain('2026-08-01T13:00:00.000Z');
  });

  it('says which digest went dark and warns that its silence is not a clean week', () => {
    const { subject, text } = formatProviderAlert(
      { kind: 'digest_send_failed', digest: 'papercut', reason: 'provider_error' },
      AT,
    );

    expect(subject).toBe('Hale ops: the weekly papercut digest failed to send');
    expect(text).toContain('provider_error');
    expect(text).toContain('never as a');
    expect(text).toContain('RESEND_API_KEY');

    const triage = formatProviderAlert(
      { kind: 'digest_send_failed', digest: 'twilio_triage', reason: 'provider_error' },
      AT,
    );
    // The triage digest is a founder SMS, so its remedy points at the SMS leg.
    expect(triage.text).toContain('FOUNDER_ALERT_PHONE');
  });
});

// ── the dedupe claim ─────────────────────────────────────────────────────────

interface ClaimCapture {
  inserted: Array<{ identifier: string; route: string; windowStart: Date; count: number }>;
  deletes: number;
}

function fakeClaimDb(alreadyClaimed: boolean): { database: Database; capture: ClaimCapture } {
  const capture: ClaimCapture = { inserted: [], deletes: 0 };
  const database = {
    delete: () => ({
      where: async () => {
        capture.deletes += 1;
      },
    }),
    insert: () => ({
      values: (row: ClaimCapture['inserted'][number]) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            capture.inserted.push(row);
            return alreadyClaimed ? [] : [{ id: 'incident-row' }];
          },
        }),
      }),
    }),
  } as unknown as Database;
  return { database, capture };
}

describe('claimProviderIncident', () => {
  it('wins the claim once per incident window and floors the window boundary', async () => {
    const { database, capture } = fakeClaimDb(false);

    const won = await claimProviderIncident(
      database,
      'provider_health:billing',
      new Date('2026-08-01T12:34:56Z'),
    );

    expect(won).toBe(true);
    const [row] = capture.inserted;
    expect(row?.identifier).toBe('provider_health:billing');
    // Floored to the incident window, so every cron in the window claims the SAME row.
    const windowMs = PROVIDER_INCIDENT_WINDOW_HOURS * 3_600_000;
    expect((row?.windowStart.getTime() ?? Number.NaN) % windowMs).toBe(0);
    // Old windows for this key are swept on write, so the table stays bounded.
    expect(capture.deletes).toBe(1);
  });

  it('loses the claim when another cron already alerted in this window', async () => {
    const { database } = fakeClaimDb(true);

    expect(
      await claimProviderIncident(database, 'provider_health:billing', new Date('2026-08-01T12:00:00Z')),
    ).toBe(false);
  });
});

// ── raise + pre-flight ───────────────────────────────────────────────────────

function deps(over: Partial<ProviderHealthDeps> = {}): ProviderHealthDeps {
  return {
    probe: vi.fn(async () => ({ ok: true }) as const),
    claim: vi.fn(async () => true),
    sender: { send: vi.fn(async () => true) },
    ...over,
  };
}

const BILLING_INCIDENT: ProviderIncident = {
  kind: 'preflight',
  window: 'weekly_plan',
  failure: 'billing',
  detail: 'Your credit balance is too low.',
};

describe('raiseProviderIncident', () => {
  it('emails the founder once when it wins the claim', async () => {
    const d = deps();

    const outcome = await raiseProviderIncident({} as Database, BILLING_INCIDENT, d, new Date());

    expect(outcome).toEqual({ alerted: true, deduped: false });
    expect(d.sender.send).toHaveBeenCalledTimes(1);
  });

  it('sends NOTHING when the incident was already alerted (dedupe, not per cron)', async () => {
    const d = deps({ claim: vi.fn(async () => false) });

    const outcome = await raiseProviderIncident({} as Database, BILLING_INCIDENT, d, new Date());

    expect(outcome).toEqual({ alerted: false, deduped: true });
    expect(d.sender.send).not.toHaveBeenCalled();
  });

  it('never throws when the email provider fails — an alert failure is not an outage', async () => {
    const d = deps({
      sender: {
        send: vi.fn(async () => {
          throw new Error('resend down');
        }),
      },
    });

    await expect(
      raiseProviderIncident({} as Database, BILLING_INCIDENT, d, new Date()),
    ).resolves.toEqual({ alerted: false, deduped: false });
  });
});

describe('providerPreflight', () => {
  const NOW = new Date('2026-08-01T12:00:00Z');
  const client = { messages: { create: vi.fn() } } as unknown as AgentClient;

  it('aborts the window and alerts on a billing failure', async () => {
    const d = deps({
      probe: vi.fn(async () => ({ ok: false, failure: 'billing', detail: 'no credit' }) as const),
    });

    const result = await providerPreflight({} as Database, 'weekly_plan', client, NOW, d);

    expect(result).toEqual({
      proceed: false,
      abort: { failure: 'billing', detail: 'no credit', alerted: true },
    });
    expect(d.sender.send).toHaveBeenCalledTimes(1);
  });

  it('PROCEEDS on a transient failure — a blip must not cancel a send window', async () => {
    const d = deps({
      probe: vi.fn(async () => ({ ok: false, failure: 'transient', detail: '529' }) as const),
    });

    const result = await providerPreflight({} as Database, 'weekly_plan', client, NOW, d);

    expect(result.proceed).toBe(true);
    expect(d.sender.send).not.toHaveBeenCalled();
  });

  it('proceeds and never probes when the cron has no LLM client this run', async () => {
    const d = deps();

    const result = await providerPreflight({} as Database, 'weekly_plan', null, NOW, d);

    expect(result).toEqual({ proceed: true, health: null });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it('proceeds silently when the provider is healthy', async () => {
    const d = deps();

    const result = await providerPreflight({} as Database, 'nudge_sweep', client, NOW, d);

    expect(result).toEqual({ proceed: true, health: { ok: true } });
    expect(d.sender.send).not.toHaveBeenCalled();
  });
});

// ── the founder alert transport ──────────────────────────────────────────────

interface SendPayload {
  to: string;
  from: string;
  subject: string;
  text: string;
}

function fakeResend() {
  const send = vi.fn(async (_payload: SendPayload) => ({ data: { id: 'resend-1' }, error: null }));
  return { emails: { send } } as never;
}

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubEnv('FOUNDER_ALERT_EMAIL', 'founder@villagehale.com');
  vi.stubEnv('WELCOME_BCC', '');
  vi.stubEnv('WELCOME_FROM', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createProviderAlertSender', () => {
  it('emails the founder address with the given subject and body', async () => {
    const client = fakeResend();

    const sent = await createProviderAlertSender(client).send('a subject', 'a body');

    expect(sent).toBe(true);
    const payload = (client as unknown as { emails: { send: { mock: { calls: [SendPayload][] } } } })
      .emails.send.mock.calls[0]?.[0];
    expect(payload?.to).toBe('founder@villagehale.com');
    expect(payload?.subject).toBe('a subject');
    expect(payload?.text).toBe('a body');
  });

  it('is a clean no-op when no founder address is configured', async () => {
    vi.stubEnv('FOUNDER_ALERT_EMAIL', '');
    const client = fakeResend();

    expect(await createProviderAlertSender(client).send('s', 'b')).toBe(false);
  });
});
