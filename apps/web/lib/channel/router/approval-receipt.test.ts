import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalSpine, resolveApproval } from './approval';
import {
  approvalReceiptInput,
  approvalReceiptRefusals,
  approvalReceiptVoiceEnabled,
  composeApprovalReceipt,
  productionApprovalReceiptVoice,
} from './approval-receipt';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'approval-receipt', whenToUse: 'x', task: 'speak', tools: [] },
    instructions: 'speak',
  }),
}));

const { forceToolJson } = await import('~/lib/pipeline/structured');
const CLIENT = {} as AgentClient;
const DB = {} as Database;
const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-07-30T12:00:00.000Z');

function spine(): ApprovalSpine {
  const action = { actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true };
  return {
    listPending: async () => [action],
    latestUndoable: async () => action,
    approve: async () => ({ ok: true }),
    decline: async () => ({ ok: true }),
    undo: async () => ({ ok: true }),
  };
}

const run = (verb: 'yes' | 'no' | 'undo', voice?: Parameters<typeof resolveApproval>[3]) =>
  resolveApproval(
    DB,
    { familyId: FAMILY, parentUserId: PARENT, command: { verb, index: null }, now: NOW },
    spine(),
    voice,
  );

beforeEach(() => vi.mocked(forceToolJson).mockReset());

describe('VIL-454 approval receipt flag', () => {
  it('is on only for exactly true', () => {
    expect(approvalReceiptVoiceEnabled({})).toBe(false);
    expect(approvalReceiptVoiceEnabled({ APPROVAL_RECEIPT_VOICE_ENABLED: '1' })).toBe(false);
    expect(approvalReceiptVoiceEnabled({ APPROVAL_RECEIPT_VOICE_ENABLED: 'true' })).toBe(true);
  });

  it('binds no voice when off, so the fixed lines stay', () => {
    vi.stubEnv('APPROVAL_RECEIPT_VOICE_ENABLED', '');
    expect(productionApprovalReceiptVoice(async () => 'en')).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe('VIL-454 approval receipt facts and gates', () => {
  it('carries the spoken action label and language only', () => {
    expect(approvalReceiptInput('approved', 'calendar_add', 'fr')).toEqual({
      kind: 'approved',
      action: expect.any(String),
      language: 'fr',
    });
  });

  it('refuses empty, long and linked drafts', () => {
    expect(approvalReceiptRefusals(' ')).toEqual(['empty']);
    expect(approvalReceiptRefusals('x'.repeat(241))).toContain('over_char_cap');
    expect(approvalReceiptRefusals('see https://x.co')).toContain('carries_link');
    expect(approvalReceiptRefusals('Got it, adding it now.')).toEqual([]);
  });

  it('retries once, then gives up with null', async () => {
    vi.mocked(forceToolJson)
      .mockResolvedValueOnce({ value: { text: '' } } as never)
      .mockResolvedValueOnce({ value: { text: 'Got it.' } } as never);
    expect(
      await composeApprovalReceipt(CLIENT, approvalReceiptInput('approved', 'calendar_add', 'en')),
    ).toBe('Got it.');
    vi.mocked(forceToolJson).mockResolvedValue({ value: {} } as never);
    expect(
      await composeApprovalReceipt(CLIENT, approvalReceiptInput('declined', 'calendar_add', 'en')),
    ).toBeNull();
    expect(vi.mocked(forceToolJson).mock.calls.length).toBe(4);
  });
});

describe('VIL-454 resolveApproval with a receipt voice', () => {
  it('keeps the fixed lines without a voice', async () => {
    expect((await run('yes')).reply).toMatch(/add to your calendar/i);
  });

  it('uses the voice for approved, declined and undone', async () => {
    const seen: string[] = [];
    const voice = async (i: { kind: string; actionType: string; familyId: string }) => {
      seen.push(`${i.kind}:${i.actionType}:${i.familyId}`);
      return `voiced ${i.kind}`;
    };
    expect((await run('yes', voice)).reply).toBe('voiced approved');
    expect((await run('no', voice)).reply).toBe('voiced declined');
    const undone = await run('undo', voice);
    expect(undone).toMatchObject({ status: 'undone', reply: 'voiced undone' });
    expect(seen).toEqual([
      `approved:calendar_add:${FAMILY}`,
      `declined:calendar_add:${FAMILY}`,
      `undone:calendar_add:${FAMILY}`,
    ]);
  });

  it('records the answer and sends nothing canned when the voice fails or throws', async () => {
    expect(await run('yes', async () => null)).toMatchObject({ status: 'approved', reply: null });
    const thrown = await run('no', async () => {
      throw new Error('x');
    });
    expect(thrown).toMatchObject({ status: 'declined', reply: null });
  });
});
