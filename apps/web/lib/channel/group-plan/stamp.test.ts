import { describe, expect, it, vi } from 'vitest';
import type { ChannelDraftInput, ChannelDraftPort } from '~/lib/channel/coach/draft';
import { type RecordGroupPlanOrigin, groupPlanDraftPort } from './stamp';

/**
 * VIL-443 (T17) — which drafts are a group's plan. The origin is recorded beside the
 * draft, never in it: the payload the reviewer reads is byte-for-byte unchanged.
 */

const ADD: ChannelDraftInput = {
  familyId: 'f1',
  actor: 'u-ana',
  actionType: 'calendar_add',
  payload: { title: 'Swim lesson', startsAt: '2026-11-07T15:00:00.000Z' },
  rationale: 'the group asked to add swim',
  teenContent: false,
};
const GROUP_TURN = { audience: 'group', conversationId: 'c-group' } as const;

function inner(): ChannelDraftPort & { draft: ReturnType<typeof vi.fn> } {
  return { draft: vi.fn(async () => ({ actionId: 'a1' })) };
}

const recording = () => vi.fn<RecordGroupPlanOrigin>(async () => 'recorded');

describe('VIL-443 groupPlanDraftPort', () => {
  it('is the inner port itself on a 1:1 turn', () => {
    const port = inner();
    const record = recording();
    expect(groupPlanDraftPort(port, { audience: 'direct', conversationId: 'c1' }, record)).toBe(
      port,
    );
  });

  it('records the origin of a calendar add drafted in the group, payload untouched', async () => {
    const port = inner();
    const record = recording();
    const result = await groupPlanDraftPort(port, GROUP_TURN, record).draft(ADD);
    expect(result).toEqual({ actionId: 'a1' });
    expect(port.draft).toHaveBeenCalledWith(ADD);
    expect(port.draft.mock.calls[0]?.[0]).toStrictEqual(ADD);
    expect(record).toHaveBeenCalledWith({
      familyId: 'f1',
      actor: 'u-ana',
      actionId: 'a1',
      conversationId: 'c-group',
    });
  });

  it('says so when the plan was made in a group that is not the household group', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const record = vi.fn<RecordGroupPlanOrigin>(async () => 'outside_household_group');
    const result = await groupPlanDraftPort(inner(), GROUP_TURN, record).draft(ADD);
    expect(result).toEqual({ actionId: 'a1' });
    expect(info).toHaveBeenCalledWith(
      { familyId: 'f1', actionId: 'a1' },
      expect.stringContaining('outside the household group'),
    );
    info.mockRestore();
  });

  it('does not mark a move or a cancel (found through the placing action instead)', async () => {
    const record = recording();
    for (const actionType of ['calendar_move', 'calendar_cancel'] as const) {
      await groupPlanDraftPort(inner(), GROUP_TURN, record).draft({
        ...ADD,
        actionType,
        payload: { ...ADD.payload, reversalHandle: 'e1' },
      });
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the draft when the origin cannot be written, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = vi.fn<RecordGroupPlanOrigin>(async () => Promise.reject(new Error('db down')));
    const result = await groupPlanDraftPort(inner(), GROUP_TURN, record).draft(ADD);
    expect(result).toEqual({ actionId: 'a1' });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'f1', actionId: 'a1' }),
      expect.stringContaining('origin unrecorded'),
    );
    error.mockRestore();
  });

  it('records nothing when the draft itself fails', async () => {
    const record = recording();
    const failing = { draft: vi.fn(async () => Promise.reject(new Error('reviewer'))) };
    await expect(groupPlanDraftPort(failing, GROUP_TURN, record).draft(ADD)).rejects.toThrow(
      'reviewer',
    );
    expect(record).not.toHaveBeenCalled();
  });
});
