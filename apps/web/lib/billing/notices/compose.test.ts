import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingClaimFacts } from '~/lib/channel/reconcile/billing-text';
import { type BillingNoticeFacts, billingNoticeRefusals, composeBillingNotice } from './compose';

/**
 * VIL-735 · the request mechanics around the writer: what counts as a refusal, how many
 * tries, and that nothing is ever returned in place of the model's text. A fake stands at
 * the AgentClient port and answers with stipulated drafts. What the model actually
 * writes is the billing-notice eval's job (rule #8).
 */

const facts: BillingNoticeFacts = {
  happened: 'payment',
  language: 'en',
  plan: 'Plus',
  previousPlan: 'Free',
  ended: null,
  refunds: [],
  paidThrough: { date: 'November 21, 2027', renews: true },
};
const claimFacts: BillingClaimFacts = {
  language: 'en',
  plan: 'Plus',
  previousPlan: 'Free',
  ended: false,
  refunds: [],
  paidThrough: { date: 'November 21, 2027', year: 2027, month: 11, day: 21 },
};

function answer(request: { tools?: unknown[] }, input: unknown): Anthropic.Message {
  const content = request.tools
    ? [{ type: 'tool_use', id: 'tu', name: 'billing_notice_text', input }]
    : [{ type: 'text', text: JSON.stringify(input) }];
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test',
    stop_reason: request.tools ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    content,
  } as unknown as Anthropic.Message;
}

function fakeClient(...drafts: (string | Error)[]) {
  const create = vi.fn(async (request: { tools?: unknown[] }) => {
    const next = drafts.shift();
    if (next === undefined) throw new Error('fake client: no reply left');
    if (next instanceof Error) throw next;
    return answer(request, { text: next });
  });
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

const compose = (
  client: AgentClient | null,
  check: (draft: string) => boolean = () => true,
  signal: AbortSignal = new AbortController().signal,
) => {
  const runs: { status: string }[] = [];
  const result = composeBillingNotice({
    client,
    facts,
    claimFacts,
    familyId: '00000000-0000-4000-8000-000000000001',
    recordRun: async (run) => {
      runs.push({ status: run.status });
    },
    signal,
    check: async ({ draft }) => check(draft),
  });
  return { result, runs };
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('billingNoticeRefusals', () => {
  it.each([
    ['', ['empty']],
    ['   ', ['empty']],
    ['See villagehale.com for more.', ['link']],
    ['Reply STOP to opt out.', ['opt_out_line']],
    ["You're on Plus now.", []],
  ])('%j', (text, expected) => {
    expect(billingNoticeRefusals(text)).toEqual(expected);
  });
});

describe('composeBillingNotice', () => {
  it('returns the model’s text once it passes the check', async () => {
    const { client } = fakeClient("You're on Plus through November 21, 2027.");
    const { result, runs } = compose(client);
    await expect(result).resolves.toEqual({
      status: 'written',
      text: "You're on Plus through November 21, 2027.",
    });
    expect(runs).toEqual([{ status: 'completed' }]);
  });

  it('a null client is unwritten, with no call and no run', async () => {
    const { result, runs } = compose(null);
    await expect(result).resolves.toEqual({ status: 'failed', reason: 'unwritten' });
    expect(runs).toEqual([]);
  });

  it('a wrong plan is refused by the floor and asked again, without spending a check', async () => {
    const { client, create } = fakeClient("You're on Max now.", "You're on Plus now.");
    const check = vi.fn(() => true);
    const { result } = compose(client, check);
    await expect(result).resolves.toEqual({ status: 'written', text: "You're on Plus now." });
    expect(create).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("You're on Plus now.");
  });

  it('two drafts the floor refuses are unwritten, and nothing stands in', async () => {
    const { client } = fakeClient("You're on Max now.", 'See villagehale.com for more.');
    const { result, runs } = compose(client);
    await expect(result).resolves.toEqual({ status: 'failed', reason: 'unwritten' });
    expect(runs).toEqual([{ status: 'failed' }, { status: 'failed' }]);
  });

  it('two drafts the fact check refuses are named fact_check', async () => {
    const { client, create } = fakeClient("You're on Plus now.", 'Plus plan, all set.');
    const { result } = compose(client, () => false);
    await expect(result).resolves.toEqual({ status: 'failed', reason: 'fact_check' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('a model error on both tries is unwritten', async () => {
    const { client } = fakeClient(new Error('down'), new Error('down'));
    const { result, runs } = compose(client);
    await expect(result).resolves.toEqual({ status: 'failed', reason: 'unwritten' });
    expect(runs).toHaveLength(2);
  });

  it('an aborted signal stops before the next try', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, create } = fakeClient("You're on Plus now.");
    const { result } = compose(client, () => true, controller.signal);
    await expect(result).resolves.toEqual({ status: 'failed', reason: 'unwritten' });
    expect(create).not.toHaveBeenCalled();
  });
});
