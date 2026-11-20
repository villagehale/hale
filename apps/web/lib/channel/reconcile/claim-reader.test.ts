import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, strictToolSchema } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ClaimCandidateRow, buildClaimCandidates } from './candidates';
import { claimRowLabel } from './claim-label';

/**
 * VIL-581 · the reader's MECHANICS against a fake AgentClient: the request it builds,
 * the answer it accepts, and that every way a read can fail comes back as its own named
 * outcome. Whether the model reads WELL is the cached claim-read eval (rule #8).
 */

// The one seam swapped here is the skill's task, so a lane with no thinking-off form can
// be reached. Every other test loads the real claim-read skill.
const skillTask: { value: string | null } = { value: null };
vi.mock('~/lib/cron/skill', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/cron/skill')>();
  return {
    ...real,
    loadCronSkill: async (name: string) => {
      const skill = await real.loadCronSkill(name);
      return skillTask.value ? { ...skill, meta: { ...skill.meta, task: skillTask.value } } : skill;
    },
  };
});
vi.resetModules();
const {
  CLAIM_READ_JSON_SCHEMA,
  CLAIM_READ_MAX_BODY_CHARS,
  CLAIM_READ_MAX_BUDGET_MS,
  CLAIM_READ_MAX_INBOUND_CHARS,
  READ_CLAIM_KINDS,
  acceptClaimRead,
  claimReadNow,
  createClaimReader,
} = await import('./claim-reader');
type ClaimReadInput = import('./claim-reader').ClaimReadInput;

const FAM = 'fam-a';
const TZ = 'America/Denver';
const SWIM: ClaimCandidateRow = {
  familyId: FAM,
  source: 'calendar',
  kind: 'scheduled_event',
  what: claimRowLabel({ from: 'pending', text: 'Swim lesson' }, new Date('2026-11-03T10:00:00Z')),
  startsAt: new Date('2026-11-07T17:00:00Z'),
};

function message(content: unknown[], stopReason: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    content,
  } as unknown as Anthropic.Message;
}
const answer = (value: unknown) =>
  message([{ type: 'text', text: JSON.stringify(value) }], 'end_turn');
const CLEAN = answer({
  reason: 'one booking claim about the swim row',
  claims: [{ sentence: 0, kind: 'scheduled_event', row: 'e1' }],
});

type Step = Anthropic.Message | Error | ((signal: AbortSignal) => Anthropic.Message | Error);

function fakeClient(...steps: Step[]) {
  const create = vi.fn(async (_body: unknown, options?: { signal?: AbortSignal }) => {
    const step = steps.shift();
    if (!step) throw new Error('fake client: no step left');
    const out = typeof step === 'function' ? step(options?.signal as AbortSignal) : step;
    if (out instanceof Error) throw out;
    return out;
  });
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

function reader(
  client: AgentClient,
  extra: Partial<{
    clock: () => number;
    wait: (ms: number, signal: AbortSignal) => Promise<void>;
    thinking: 'adaptive' | 'off';
    timer: (ms: number) => AbortSignal;
  }> = {},
) {
  return createClaimReader({
    client,
    wait: extra.wait ?? (async () => {}),
    clock: extra.clock ?? (() => 0),
    thinking: extra.thinking ?? 'adaptive',
    // A deadline that never fires unless a test fires it.
    timer: extra.timer ?? (() => new AbortController().signal),
  });
}

function input(over: Partial<ClaimReadInput> = {}): ClaimReadInput {
  return {
    body: 'Your swim lesson is booked. See you there.',
    language: 'en',
    timeZone: TZ,
    now: new Date('2026-11-03T10:00:00Z'),
    candidates: buildClaimCandidates(FAM, [SWIM], TZ),
    signal: new AbortController().signal,
    budgetMs: CLAIM_READ_MAX_BUDGET_MS,
    ...over,
  };
}

const apiError = (status: number, type: string, text: string, extra: object = {}, headers = {}) =>
  Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message: text, ...extra } },
    undefined,
    { 'request-id': 'req_test', ...headers },
  );
const SPEND_CAP = apiError(429, 'rate_limit_error', 'You have reached your API usage limits.', {
  details: { error_code: 'enforced_spend_limit_reached' },
});

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  skillTask.value = null;
  vi.restoreAllMocks();
});

describe('the output schema', () => {
  it('compiles to a grammar; an open object would not (control)', () => {
    expect(strictToolSchema(CLAIM_READ_JSON_SCHEMA as never)).not.toBeNull();
    const open = structuredClone(CLAIM_READ_JSON_SCHEMA) as unknown as {
      properties: { claims: { items: unknown } };
    };
    open.properties.claims.items = { type: 'object', additionalProperties: {} };
    expect(strictToolSchema(open as never)).toBeNull();
  });

  it('puts reason first and pins both enums', () => {
    expect(CLAIM_READ_JSON_SCHEMA.required).toEqual(['reason', 'claims']);
    expect(Object.keys(CLAIM_READ_JSON_SCHEMA.properties)).toEqual(['reason', 'claims']);
    const item = CLAIM_READ_JSON_SCHEMA.properties.claims.items;
    expect(item.required).toEqual(['sentence', 'kind', 'row']);
    const hand = [
      'none',
      ...Array.from({ length: 50 }, (_, i) => `e${i + 1}`),
      ...Array.from({ length: 20 }, (_, i) => `s${i + 1}`),
      ...['c1', 'c2', 'c3', 'c4', 'c5'],
      ...['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10'],
      ...['q1', 'q2', 'q3', 'q4', 'q5'],
      'w1',
      ...Array.from({ length: 10 }, (_, i) => `r${i + 1}`),
      ...Array.from({ length: 10 }, (_, i) => `m${i + 1}`),
      ...Array.from({ length: 10 }, (_, i) => `x${i + 1}`),
      'p1',
      'p2',
    ];
    expect(item.properties.row.enum).toEqual(hand);
    expect(item.properties.kind.enum).toEqual([
      'scheduled_event',
      'registration_watch',
      'spot_watch',
      'activity_followup',
      'co_parent_invite',
      'self_referential',
      'registration_done',
      'send_done',
      'send_received',
      'cancelled',
    ]);
    expect(READ_CLAIM_KINDS).toEqual(item.properties.kind.enum);
  });
});

describe('the request', () => {
  const sent = (create: ReturnType<typeof fakeClient>['create']) =>
    JSON.parse(
      (create.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]?.content ?? '',
    );

  it('carries a certain language hint, the family-local now, numbered sentences and rows', async () => {
    const { client, create } = fakeClient(CLEAN);
    await reader(client).read(input({ language: 'fr' }));
    const payload = sent(create);
    expect(payload.languageHint).toBe('fr');
    expect(payload.now).toBe('2026-11-03T03:00-07:00');
    expect('inbound' in payload).toBe(false);
    expect(payload.sentences).toEqual([
      { i: 0, text: 'Your swim lesson is booked.' },
      { i: 1, text: 'See you there.' },
    ]);
    expect(payload.rows).toEqual([
      {
        a: 'e1',
        kind: 'scheduled_event',
        state: 'open',
        what: 'Swim lesson',
        when: 'Sat, Nov 7, 10:00 AM',
      },
    ]);
  });

  it('a sentence is not a language hint, and inbound rides only when given', async () => {
    const { client, create } = fakeClient(CLEAN);
    await reader(client).read(input({ language: 'Bonjour!', inbound: 'Is swim booked?' }));
    const payload = sent(create);
    expect(payload.languageHint).toBeNull();
    expect(payload.inbound).toBe('Is swim booked?');
  });

  it('formats now with the offset of the zone it is given', () => {
    const at = new Date('2026-11-03T10:00:00Z');
    expect(claimReadNow(at, 'America/Denver')).toBe('2026-11-03T03:00-07:00');
    expect(claimReadNow(at, 'America/New_York')).toBe('2026-11-03T05:00-05:00');
    expect(claimReadNow(at, 'UTC')).toBe('2026-11-03T10:00+00:00');
  });

  it('goes out on the screen lane, through create, with the signal as an option', async () => {
    const { client, create } = fakeClient(CLEAN);
    await reader(client).read(input());
    const [body, options] = create.mock.calls[0] as [
      Record<string, unknown>,
      { signal: AbortSignal },
    ];
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('acceptance', () => {
  it('an out-of-range sentence index is unparseable after one retry', async () => {
    const bad = answer({
      reason: 'r',
      claims: [{ sentence: 2, kind: 'scheduled_event', row: 'e1' }],
    });
    const { client, create } = fakeClient(bad, bad);
    const out = await reader(client).read(input());
    expect(out).toMatchObject({ status: 'failed', reason: 'unparseable', attempts: 2 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('the last index is in range (control)', async () => {
    const ok = answer({
      reason: 'r',
      claims: [{ sentence: 1, kind: 'scheduled_event', row: 'e1' }],
    });
    const out = await reader(fakeClient(ok).client).read(input());
    expect(out).toMatchObject({ status: 'read', attempts: 1 });
  });

  it('collapses exact duplicate claims', async () => {
    const twice = answer({
      reason: 'r',
      claims: [
        { sentence: 0, kind: 'scheduled_event', row: 'e1' },
        { sentence: 0, kind: 'scheduled_event', row: 'e1' },
        { sentence: 0, kind: 'scheduled_event', row: 'none' },
      ],
    });
    const out = await reader(fakeClient(twice).client).read(input());
    expect(out.status === 'read' && out.claims).toEqual([
      { segment: 0, kind: 'scheduled_event', row: 'e1' },
      { segment: 0, kind: 'scheduled_event', row: 'none' },
    ]);
  });

  it('acceptClaimRead refuses a shape outside the schema, and accepts the schema (control)', () => {
    expect(acceptClaimRead({ claims: [] }, 1)).toEqual({ ok: false });
    expect(
      acceptClaimRead({ reason: 'r', claims: [{ sentence: 0, kind: 'invented', row: 'e1' }] }, 1),
    ).toEqual({
      ok: false,
    });
    expect(
      acceptClaimRead(
        { reason: 'r', claims: [{ sentence: -1, kind: 'spot_watch', row: 'g1' }] },
        1,
      ),
    ).toEqual({
      ok: false,
    });
    expect(acceptClaimRead({ reason: 'r', claims: [] }, 1)).toEqual({ ok: true, claims: [] });
  });
});

describe('every failure is named', () => {
  it('a connection error twice is unreachable, two attempts', async () => {
    const down = () => new Anthropic.APIConnectionError({ message: 'down' });
    const out = await reader(fakeClient(down(), down()).client).read(input());
    expect(out).toMatchObject({ status: 'failed', reason: 'unreachable', attempts: 2 });
  });

  it('a 503 twice is unreachable', async () => {
    const e = () => apiError(503, 'overloaded_error', 'Overloaded');
    const out = await reader(fakeClient(e(), e()).client).read(input());
    expect(out).toMatchObject({ status: 'failed', reason: 'unreachable', attempts: 2 });
  });

  it('a plain 429 waits its retry-after, then reads', async () => {
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const limited = apiError(
      429,
      'rate_limit_error',
      'Too many requests',
      {},
      { 'retry-after': '1' },
    );
    const out = await reader(fakeClient(limited, CLEAN).client, { wait }).read(input());
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]?.[0]).toBe(1000);
    expect(out).toMatchObject({ status: 'read', attempts: 2 });
  });

  it('the tier spend-cap 429 is an incident, never retried', async () => {
    const wait = vi.fn(async () => {});
    const { client, create } = fakeClient(SPEND_CAP, CLEAN);
    const out = await reader(client, { wait }).read(input());
    expect(out).toMatchObject({
      status: 'failed',
      reason: 'incident',
      incident: 'usage_limit',
      attempts: 1,
    });
    expect(wait).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('truncation and refusal are named and not retried', async () => {
    const cut = message([{ type: 'text', text: '{"reason":"r","cl' }], 'max_tokens');
    const truncated = fakeClient(cut, CLEAN);
    expect(await reader(truncated.client).read(input())).toMatchObject({
      status: 'failed',
      reason: 'truncated',
      attempts: 1,
    });
    expect(truncated.create).toHaveBeenCalledTimes(1);
    const refusal = fakeClient(message([], 'refusal'), CLEAN);
    expect(await reader(refusal.client).read(input())).toMatchObject({
      status: 'failed',
      reason: 'refused',
      attempts: 1,
    });
  });

  it('a budget under the floor makes no call: no_budget, zero attempts', async () => {
    const { client, create } = fakeClient(CLEAN);
    const out = await reader(client).read(input({ budgetMs: 4_999 }));
    expect(out).toMatchObject({ status: 'failed', reason: 'no_budget', attempts: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it("an already-aborted caller's signal is no_budget", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, create } = fakeClient(CLEAN);
    const out = await reader(client).read(input({ signal: controller.signal }));
    expect(out).toMatchObject({ status: 'failed', reason: 'no_budget' });
    expect(create).not.toHaveBeenCalled();
  });

  it('a starved retry returns the first reason with one attempt, never no_budget', async () => {
    let now = 0;
    const slowDown = () => {
      now += 12_000;
      return new Anthropic.APIConnectionError({ message: 'down' });
    };
    const { client, create } = fakeClient(slowDown, slowDown);
    const out = await reader(client, { clock: () => now }).read(input({ budgetMs: 15_000 }));
    expect(out).toMatchObject({ status: 'failed', reason: 'unreachable', attempts: 1 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a retry with room left happens (control)', async () => {
    let now = 0;
    const quickDown = () => {
      now += 2_000;
      return new Anthropic.APIConnectionError({ message: 'down' });
    };
    const { client, create } = fakeClient(quickDown, quickDown);
    const out = await reader(client, { clock: () => now }).read(input({ budgetMs: 15_000 }));
    expect(out).toMatchObject({ status: 'failed', reason: 'unreachable', attempts: 2 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("an abort that is not the caller's is our own deadline: unreachable", async () => {
    const abort = () => new Anthropic.APIUserAbortError();
    const out = await reader(fakeClient(abort, abort).client).read(input());
    expect(out).toMatchObject({ status: 'failed', reason: 'unreachable' });
  });

  it('thinking off on a lane with no thinking-off form is lane_unavailable, no call', async () => {
    skillTask.value = 'speak';
    const { client, create } = fakeClient(CLEAN);
    const out = await reader(client, { thinking: 'off' }).read(input());
    expect(out).toMatchObject({ status: 'failed', reason: 'lane_unavailable', attempts: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it('thinking off on the screen lane sends thinking disabled (control)', async () => {
    const { client, create } = fakeClient(CLEAN);
    const out = await reader(client, { thinking: 'off' }).read(input());
    expect(out.status).toBe('read');
    expect((create.mock.calls[0]?.[0] as { thinking: unknown }).thinking).toEqual({
      type: 'disabled',
    });
  });

  it('a clean answer is a read on the first attempt (control)', async () => {
    const out = await reader(fakeClient(CLEAN).client).read(input());
    expect(out).toMatchObject({
      status: 'read',
      attempts: 1,
      claims: [{ segment: 0, kind: 'scheduled_event', row: 'e1' }],
      usage: { input: 10, output: 5 },
    });
    expect(out.status === 'read' && out.segments.map((s) => s.text)).toEqual([
      'Your swim lesson is booked.',
      'See you there.',
    ]);
  });
});

describe('the signal', () => {
  it("aborting the caller's signal mid-call aborts the signal the client received", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const midCall = (signal: AbortSignal) => {
      received = signal;
      controller.abort();
      return new Anthropic.APIUserAbortError();
    };
    const out = await reader(fakeClient(midCall).client).read(input({ signal: controller.signal }));
    expect(received?.aborted).toBe(true);
    expect(out).toMatchObject({ status: 'failed', reason: 'no_budget', attempts: 1 });
  });

  it('with nothing aborted, the received signal is live when the client answers (control)', async () => {
    let received: AbortSignal | undefined;
    const fine = (signal: AbortSignal) => {
      received = signal;
      return CLEAN;
    };
    await reader(fakeClient(fine).client).read(input());
    expect(received?.aborted).toBe(false);
  });
});

describe('the failure log', () => {
  it('names the outcome and never carries the body', async () => {
    const down = () => new Anthropic.APIConnectionError({ message: 'down ZQXJ-SENTINEL' });
    await reader(fakeClient(down(), down()).client).read(
      input({ body: 'Your ZQXJ-SENTINEL visit is booked.' }),
    );
    const failures = errorLog.mock.calls.filter(
      ([meta]) => (meta as { event?: string })?.event === 'claim_read_failed',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toEqual({
      event: 'claim_read_failed',
      reason: 'unreachable',
      attempts: 2,
      err: 'APIConnectionError',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('ZQXJ-SENTINEL');
  });
});

describe('size bounds (review item 2)', () => {
  const sentPayload = (create: ReturnType<typeof fakeClient>['create']) =>
    JSON.parse(
      (create.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]?.content ?? '',
    );

  it('a body over the bound makes no call: oversize, zero attempts, not our deadline', async () => {
    expect(CLAIM_READ_MAX_BODY_CHARS).toBe(8_000);
    const { client, create } = fakeClient(CLEAN);
    const out = await reader(client).read(input({ body: 'a'.repeat(8_001) }));
    expect(out).toEqual({
      status: 'failed',
      reason: 'oversize',
      attempts: 0,
      deadline: false,
      latencyMs: 0,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('a body at the bound is read (control)', async () => {
    const { client, create } = fakeClient(CLEAN);
    const out = await reader(client).read(input({ body: 'a'.repeat(8_000) }));
    expect(out.status).toBe('read');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the bounds count code points, not UTF-16 units: an astral body at the bound is read', async () => {
    const astral = '\u{1F600}';
    const at = fakeClient(CLEAN);
    expect(astral.repeat(8_000).length).toBe(16_000);
    expect((await reader(at.client).read(input({ body: astral.repeat(8_000) }))).status).toBe(
      'read',
    );
    const over = fakeClient(CLEAN);
    const out = await reader(over.client).read(input({ body: astral.repeat(8_001) }));
    expect(out).toMatchObject({ status: 'failed', reason: 'oversize' });
    const cut = fakeClient(CLEAN);
    await reader(cut.client).read(input({ inbound: astral.repeat(2_050) }));
    const inbound: string = sentPayload(cut.create).inbound;
    expect([...inbound]).toHaveLength(2_000);
    // Never mid-surrogate: every code point is the whole emoji.
    expect([...inbound].every((point) => point === astral)).toBe(true);
  });

  it('inbound is cut to 2,000 code points; a short one is byte-identical (control)', async () => {
    expect(CLAIM_READ_MAX_INBOUND_CHARS).toBe(2_000);
    const long = fakeClient(CLEAN);
    await reader(long.client).read(input({ inbound: 'é'.repeat(2_050) }));
    expect([...sentPayload(long.create).inbound]).toHaveLength(2_000);
    const short = fakeClient(CLEAN);
    const thirty = 'Is the Saturday swim booked yet';
    await reader(short.client).read(input({ inbound: thirty }));
    expect(sentPayload(short.create).inbound).toBe(thirty);
  });
});

describe('a provider error the reader does not recognise is named (review item 3)', () => {
  for (const [status, type] of [
    [400, 'invalid_request_error'],
    [404, 'not_found_error'],
    [422, 'invalid_request_error'],
  ] as const) {
    it(`a ${status} is provider_rejected, one attempt, logged by name only`, async () => {
      const { client, create } = fakeClient(apiError(status, type, 'ZQXJ'), CLEAN);
      const out = await reader(client).read(input());
      expect(out).toMatchObject({
        status: 'failed',
        reason: 'provider_rejected',
        attempts: 1,
        deadline: false,
      });
      expect(create).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain('ZQXJ');
      expect(logged).toContain('claim_read_failed');
    });
  }

  it('the log names the 400 by its class', async () => {
    await reader(fakeClient(apiError(400, 'invalid_request_error', 'ZQXJ')).client).read(input());
    expect(JSON.stringify(errorLog.mock.calls)).toContain('BadRequestError');
  });

  it('a billing-shaped 400 is still an incident (classification order holds)', async () => {
    const credit = apiError(
      400,
      'invalid_request_error',
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    );
    const out = await reader(fakeClient(credit).client).read(input());
    expect(out).toMatchObject({ status: 'failed', reason: 'incident', incident: 'billing' });
  });

  it('a plain TypeError still rejects: a bug is not masked (control)', async () => {
    const bug = new TypeError('not a provider error');
    await expect(reader(fakeClient(bug).client).read(input())).rejects.toBe(bug);
  });
});

describe('the deadline (review item 7)', () => {
  it('the timer is the budget, capped at the max budget', async () => {
    const timer = vi.fn((_ms: number) => new AbortController().signal);
    await reader(fakeClient(CLEAN).client, { timer }).read(input({ budgetMs: 20_000 }));
    expect(timer.mock.calls).toEqual([[15_000]]);
  });

  it('a budget under the max is the timer as given (control)', async () => {
    const timer = vi.fn((_ms: number) => new AbortController().signal);
    await reader(fakeClient(CLEAN).client, { timer }).read(input({ budgetMs: 8_000 }));
    expect(timer.mock.calls).toEqual([[8_000]]);
  });

  it('our own timer firing mid-call is unreachable, deadline true', async () => {
    const own = new AbortController();
    let now = 0;
    const midCall = (signal: AbortSignal) => {
      own.abort();
      now = 11_000;
      return signal.aborted ? new Anthropic.APIUserAbortError() : new Error('signal not wired');
    };
    const out = await reader(fakeClient(midCall).client, {
      timer: () => own.signal,
      clock: () => now,
    }).read(input());
    expect(out).toMatchObject({
      status: 'failed',
      reason: 'unreachable',
      deadline: true,
      attempts: 1,
    });
  });

  it("the caller's signal aborting mid-call is no_budget, deadline false (control)", async () => {
    const caller = new AbortController();
    let now = 0;
    const midCall = (signal: AbortSignal) => {
      caller.abort();
      now = 11_000;
      return signal.aborted ? new Anthropic.APIUserAbortError() : new Error('signal not wired');
    };
    const out = await reader(fakeClient(midCall).client, { clock: () => now }).read(
      input({ signal: caller.signal }),
    );
    expect(out).toMatchObject({
      status: 'failed',
      reason: 'no_budget',
      deadline: false,
      attempts: 1,
    });
  });
});

describe('retry-after is subtracted from the remaining budget (review item 7)', () => {
  const limited = (seconds: number) =>
    apiError(429, 'rate_limit_error', 'Too many requests', {}, { 'retry-after': String(seconds) });

  it('4,000 ms spent plus a 7 s retry-after leaves under the floor: no retry', async () => {
    let now = 0;
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const spend = () => {
      now = 4_000;
      return limited(7);
    };
    const { client, create } = fakeClient(spend, CLEAN);
    const out = await reader(client, { clock: () => now, wait }).read(input({ budgetMs: 15_000 }));
    expect(out).toMatchObject({ status: 'failed', reason: 'rate_limited', attempts: 1 });
    expect(wait).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a 5 s retry-after leaves 6,000 ms: it waits and retries (control)', async () => {
    let now = 0;
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const spend = () => {
      now = 4_000;
      return limited(5);
    };
    const { client, create } = fakeClient(spend, CLEAN);
    const out = await reader(client, { clock: () => now, wait }).read(input({ budgetMs: 15_000 }));
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([5_000]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ status: 'read', attempts: 2 });
  });
});
