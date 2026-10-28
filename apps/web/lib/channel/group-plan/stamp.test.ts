import { describe, expect, it, vi } from 'vitest';
import type { ChannelDraftInput, ChannelDraftPort } from '~/lib/channel/coach/draft';
import { groupPlanDraftPort } from './stamp';

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

function inner(): ChannelDraftPort & { draft: ReturnType<typeof vi.fn> } {
  return { draft: vi.fn(async () => ({ actionId: 'a1' })) };
}

describe('VIL-443 groupPlanDraftPort', () => {
  it('is the inner port itself on a 1:1 turn', () => {
    const port = inner();
    const record = vi.fn();
    expect(groupPlanDraftPort(port, 'direct', record)).toBe(port);
  });

  it('records the origin of a calendar add drafted in the group, payload untouched', async () => {
    const port = inner();
    const record = vi.fn(async () => {});
    const result = await groupPlanDraftPort(port, 'group', record).draft(ADD);
    expect(result).toEqual({ actionId: 'a1' });
    expect(port.draft).toHaveBeenCalledWith(ADD);
    expect(port.draft.mock.calls[0]?.[0]).toStrictEqual(ADD);
    expect(record).toHaveBeenCalledWith({ familyId: 'f1', actor: 'u-ana', actionId: 'a1' });
  });

  it('does not mark a move or a cancel (found through the placing action instead)', async () => {
    const record = vi.fn(async () => {});
    for (const actionType of ['calendar_move', 'calendar_cancel'] as const) {
      await groupPlanDraftPort(inner(), 'group', record).draft({
        ...ADD,
        actionType,
        payload: { ...ADD.payload, reversalHandle: 'e1' },
      });
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the draft when the origin cannot be written, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = vi.fn(async () => Promise.reject(new Error('db down')));
    const result = await groupPlanDraftPort(inner(), 'group', record).draft(ADD);
    expect(result).toEqual({ actionId: 'a1' });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'f1', actionId: 'a1' }),
      expect.stringContaining('origin unrecorded'),
    );
    error.mockRestore();
  });

  it('records nothing when the draft itself fails', async () => {
    const record = vi.fn(async () => {});
    const failing = { draft: vi.fn(async () => Promise.reject(new Error('reviewer'))) };
    await expect(groupPlanDraftPort(failing, 'group', record).draft(ADD)).rejects.toThrow(
      'reviewer',
    );
    expect(record).not.toHaveBeenCalled();
  });
});
