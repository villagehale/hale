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
  classifyChainedProviderFailure,
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
function apiError(
  status: number,
  type: string,
  message: string,
  extra: { details?: object; headers?: Record<string, string> } = {},
): unknown {
  return Anthropic.APIError.generate(
    status,
    {
      type: 'error',
      error: { type, message, ...(extra.details ? { details: extra.details } : {}) },
    },
    undefined,
    extra.headers ?? { 'request-id': 'req_probe' },
  );
}

/** A hand-built frame with the SDK error's fields but none of its prototype. */
const plainFrame = (status: unknown, type: string, message: string, details?: object) => ({
  status,
  error: { type: 'error', error: { type, message, ...(details ? { details } : {}) } },
});

const CREDIT_EXHAUSTED = apiError(
  400,
  'invalid_request_error',
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
);

/** The 2026-10-31 outage: every call refused for ~19 h. The first sentence is the
 * provider's text from that day; the regain clause is the usual Anthropic shape. */
const USAGE_LIMIT_TEXT =
  'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.';
const USAGE_LIMIT = apiError(400, 'invalid_request_error', USAGE_LIMIT_TEXT);

/** The three spend-limit refusals, from Anthropic's rate-limits doc
 * (platform.claude.com/docs/en/api/rate-limits, read 2026-11-03). Only the message
 * prefixes and the error_code carry meaning; the regain clauses are illustrative. */
const WORKSPACE_LIMIT_TEXT =
  'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.';
const SPEND_CAP_TEXT =
  "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-12-01 at 00:00 UTC.";
/** The tier cap: a 429 with NO retry-after — it does not clear until the 1st. */
const SPEND_CAP = apiError(429, 'rate_limit_error', SPEND_CAP_TEXT, {
  details: { error_code: 'enforced_spend_limit_reached' },
});
/** Invented request echo: a 400 whose text merely mentions a usage limit. */
const ECHOED_USAGE_LIMIT = 'messages.0.content: text mentions a usage limit of 3 per day';

describe('classifyChainedProviderFailure', () => {
  it('reads a billing 400 through the coach wrapper and ignores a 5xx', () => {
    const wrapped = new Error('channel coach: agent loop failed', { cause: CREDIT_EXHAUSTED });
    expect(classifyChainedProviderFailure(wrapped)).toBe('billing');
    expect(classifyProviderFailure(wrapped)).toBe('transient');
    const down = new Error('channel coach: agent loop failed', {
      cause: apiError(500, 'api_error', 'Internal server error'),
    });
    expect(classifyChainedProviderFailure(down)).toBeNull();
    expect(
      classifyChainedProviderFailure(apiError(401, 'authentication_error', 'invalid x-api-key')),
    ).toBe('auth');
  });

  it('reads a usage-limit 400 through the coach wrapper', () => {
    const wrapped = new Error('channel coach: agent loop failed', { cause: USAGE_LIMIT });
    expect(classifyChainedProviderFailure(wrapped)).toBe('usage_limit');
  });

  it('reads the tier spend-cap 429 through the coach wrapper', () => {
    const wrapped = new Error('channel coach: agent loop failed', { cause: SPEND_CAP });
    expect(classifyChainedProviderFailure(wrapped)).toBe('usage_limit');
  });

  it('reads an exact plain cause-chain frame of the org 400', () => {
    const wrapped = new Error('wrapper', {
      cause: plainFrame(400, 'invalid_request_error', USAGE_LIMIT_TEXT),
    });
    expect(classifyChainedProviderFailure(wrapped)).toBe('usage_limit');
  });
});

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
      name: 'an ordinary rate-limit 429 with a retry-after — control for the tier spend cap',
      err: apiError(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit', {
        headers: { 'request-id': 'req_probe', 'retry-after': '30' },
      }),
      expected: 'quota',
    },
    {
      name: 'the tier monthly spend-cap 429 (error_code enforced_spend_limit_reached)',
      err: SPEND_CAP,
      expected: 'usage_limit',
    },
    {
      name: 'the spend-cap text on a 429 WITHOUT the error_code stays quota — control for the tier cap',
      err: apiError(429, 'rate_limit_error', SPEND_CAP_TEXT),
      expected: 'quota',
    },
    {
      name: 'the workspace spend-limit 400',
      err: apiError(400, 'invalid_request_error', WORKSPACE_LIMIT_TEXT),
      expected: 'usage_limit',
    },
    {
      name: 'the org usage-limit body under 402 is not a usage limit',
      err: apiError(402, 'invalid_request_error', USAGE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'the org usage-limit body under 500 is not a usage limit',
      err: apiError(500, 'invalid_request_error', USAGE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'the org usage-limit body under 529 is not a usage limit',
      err: apiError(529, 'invalid_request_error', USAGE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'the workspace body under 402 is not a usage limit',
      err: apiError(402, 'invalid_request_error', WORKSPACE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'the workspace body under 500 is not a usage limit',
      err: apiError(500, 'invalid_request_error', WORKSPACE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'a 400 that merely mentions a usage limit (request echo) does not abort',
      err: apiError(400, 'invalid_request_error', ECHOED_USAGE_LIMIT),
      expected: 'transient',
    },
    {
      name: 'an exact plain frame of the org 400',
      err: plainFrame(400, 'invalid_request_error', USAGE_LIMIT_TEXT),
      expected: 'usage_limit',
    },
    {
      name: 'an exact plain frame of the tier-cap 429',
      err: plainFrame(429, 'rate_limit_error', SPEND_CAP_TEXT, {
        error_code: 'enforced_spend_limit_reached',
      }),
      expected: 'usage_limit',
    },
    {
      name: 'a plain 400 frame that merely mentions a usage limit',
      err: plainFrame(400, 'invalid_request_error', ECHOED_USAGE_LIMIT),
      expected: 'transient',
    },
    {
      name: 'a plain 400 frame with the prefix in another case',
      err: plainFrame(400, 'invalid_request_error', USAGE_LIMIT_TEXT.toLowerCase()),
      expected: 'transient',
    },
    {
      name: 'a plain frame whose status is the string "400"',
      err: plainFrame('400', 'invalid_request_error', USAGE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'a plain 402 frame with the org body',
      err: plainFrame(402, 'invalid_request_error', USAGE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'a plain 500 frame with the org body',
      err: plainFrame(500, 'invalid_request_error', USAGE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'a plain 400 frame with the wrong error type',
      err: plainFrame(400, 'api_error', USAGE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'a plain 429 frame with the error_code but the wrong error type',
      err: plainFrame(429, 'invalid_request_error', SPEND_CAP_TEXT, {
        error_code: 'enforced_spend_limit_reached',
      }),
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
      name: 'the 10-31 usage-limit 400',
      err: USAGE_LIMIT,
      expected: 'usage_limit',
    },
    {
      name: 'a usage-limit 400 that also mentions Plans & Billing (usage limit wins)',
      err: apiError(
        400,
        'invalid_request_error',
        `${USAGE_LIMIT_TEXT} Manage limits in Plans & Billing.`,
      ),
      expected: 'usage_limit',
    },
    {
      name: 'usage-limit text under a non-invalid_request type stays transient — control for the 10-31 row',
      err: apiError(400, 'api_error', USAGE_LIMIT_TEXT),
      expected: 'transient',
    },
    {
      name: 'usage-limit text only in a wrapper message, with no provider body',
      err: Object.assign(new Error(USAGE_LIMIT_TEXT), { status: 400 }),
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

  it('aborts on usage_limit: every call is refused until the limit is raised or resets', () => {
    expect(abortsSendWindow('usage_limit')).toBe(true);
  });
});

describe('probeProviderHealth', () => {
  it('spends one token on the cheapest model and reports healthy', async () => {
    const create = vi.fn(
      async (_params: { model: string; max_tokens: number }, _options?: unknown) => ({
        id: 'msg_1',
        content: [],
      }),
    );
    const client = { messages: { create } } as unknown as AgentClient;

    expect(await probeProviderHealth(client)).toEqual({ ok: true });

    const payload = create.mock.calls[0]?.[0];
    expect(payload?.model).toBe(HAIKU_MODEL);
    expect(payload?.max_tokens).toBe(1);
    // One attempt: the SDK retries every 429, and the tier spend cap is a 429 that
    // never clears on its own.
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
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
    const billingFromInference = providerIncidentKey({
      kind: 'preflight',
      window: 'memory_inference',
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

    const spend = providerIncidentKey({ kind: 'spend_threshold', totalUsd: 1, thresholdUsd: 1 });

    expect(billing).toBe(billingFromInference);
    expect(new Set([billing, auth, spike, spend]).size).toBe(4);
  });
});

describe('formatProviderAlert', () => {
  const AT = new Date('2026-08-01T12:00:00Z');

  it('leads with what did not happen, then why, then what to do', () => {
    const { subject, text } = formatProviderAlert(
      {
        kind: 'preflight',
        window: 'nudge_sweep',
        failure: 'billing',
        detail: 'Your credit balance is too low to access the Anthropic API.',
      },
      AT,
    );

    expect(subject).toBe('Hale ops: nudge sweep did not send — Anthropic billing');
    expect(text).toContain("this hour's nudge sweep did not run.");
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

  it('reports the spend threshold with both dollar amounts, the month and the env name', () => {
    const { subject, text } = formatProviderAlert(
      { kind: 'spend_threshold', totalUsd: 50, thresholdUsd: 50 },
      new Date('2026-10-31T10:27:00Z'),
    );

    expect(subject).toContain('$50.00');
    expect(text).toContain('$50.00');
    expect(text).toContain('2026-10');
    expect(text).toContain('ANTHROPIC_SPEND_ALERT_USD');
  });

  it('gives the usage-limit class its own explanation and remedy', () => {
    const { subject, text } = formatProviderAlert(
      {
        kind: 'preflight',
        window: 'nudge_sweep',
        failure: 'usage_limit',
        detail: USAGE_LIMIT_TEXT,
      },
      AT,
    );

    expect(subject).toBe('Hale ops: nudge sweep did not send — Anthropic usage_limit');
    expect(text).toContain(
      'classification: usage_limit — the account hit an Anthropic spend limit (org, workspace or monthly tier cap)',
    );
    expect(text).toContain('raise the org or workspace spend limit in the Anthropic console');
    expect(text).toContain('for the monthly tier cap, move up a tier');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('top up');
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
      await claimProviderIncident(
        database,
        'provider_health:billing',
        new Date('2026-08-01T12:00:00Z'),
      ),
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
  window: 'nudge_sweep',
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

    const result = await providerPreflight({} as Database, 'nudge_sweep', client, NOW, d);

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

    const result = await providerPreflight({} as Database, 'nudge_sweep', client, NOW, d);

    expect(result.proceed).toBe(true);
    expect(d.sender.send).not.toHaveBeenCalled();
  });

  it('proceeds and never probes when the cron has no LLM client this run', async () => {
    const d = deps();

    const result = await providerPreflight({} as Database, 'nudge_sweep', null, NOW, d);

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

beforeEach(() => {
  vi.stubEnv('WELCOME_BCC', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createProviderAlertSender', () => {
  it('posts the subject and body to Slack #ops', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/test');
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const sent = await createProviderAlertSender().send('a subject', 'a body');

    expect(sent).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(body.text).toBe('a subject\na body');
  });

  it('is a clean no-op when #ops is not configured', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');
    expect(await createProviderAlertSender().send('s', 'b')).toBe(false);
  });
});
