import { afterEach, describe, expect, it, vi } from 'vitest';
import { type GroupLeavePorts, leaveGroupOnFamilyAsk } from './group-leave';

const CHAT = '550e8400-e29b-41d4-a716-446655440000';
const OTHERS = ['+14375550101', '+14375550102', '+14375550103'];

function ports(over: Partial<{ handles: string[]; isGroup: boolean | null }> = {}) {
  const leave = vi.fn(async () => ({ status: 'accepted' as const }));
  const listParticipants = vi.fn(async () => ({
    status: 'ok' as const,
    handles: over.handles ?? OTHERS,
    isGroup: over.isGroup === undefined ? true : over.isGroup,
  }));
  return {
    leave,
    listParticipants,
    ports: { leave, listParticipants } as unknown as GroupLeavePorts,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('leaveGroupOnFamilyAsk', () => {
  it.each([undefined, '', 'on', 'false'])('stays dark when the flag is %s', async (v) => {
    if (v !== undefined) vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', v);
    const p = ports();
    expect(await leaveGroupOnFamilyAsk({ chatId: CHAT, explicitAsk: true }, p.ports)).toEqual({
      status: 'skipped',
      reason: 'flag_off',
    });
    expect(p.leave).not.toHaveBeenCalled();
  });

  it('never leaves without an explicit family ask', async () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', 'true');
    const p = ports();
    const out = await leaveGroupOnFamilyAsk({ chatId: CHAT, explicitAsk: false }, p.ports);
    expect(out).toEqual({ status: 'skipped', reason: 'no_explicit_ask' });
    expect(p.listParticipants).not.toHaveBeenCalled();
    expect(p.leave).not.toHaveBeenCalled();
  });

  it('refuses a 1:1 or unknown chat shape', async () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', 'true');
    for (const isGroup of [false, null]) {
      const p = ports({ isGroup });
      const out = await leaveGroupOnFamilyAsk({ chatId: CHAT, explicitAsk: true }, p.ports);
      expect(out).toEqual({ status: 'skipped', reason: 'not_group' });
      expect(p.leave).not.toHaveBeenCalled();
    }
  });

  it('refuses when leaving would drop the group below 3 members', async () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', 'true');
    const p = ports({ handles: OTHERS.slice(0, 2) });
    const out = await leaveGroupOnFamilyAsk({ chatId: CHAT, explicitAsk: true }, p.ports);
    expect(out).toEqual({ status: 'skipped', reason: 'too_small' });
    expect(p.leave).not.toHaveBeenCalled();
  });

  it('leaves through the door when asked, flag on, and the group keeps 3', async () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', 'true');
    const p = ports();
    const out = await leaveGroupOnFamilyAsk({ chatId: CHAT, explicitAsk: true }, p.ports);
    expect(out).toEqual({ status: 'left' });
    expect(p.leave).toHaveBeenCalledWith({ chatId: CHAT });
  });

  it('names a Linq refusal', async () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', 'true');
    const p = ports();
    p.leave.mockResolvedValueOnce({
      status: 'refused',
      code: '2013',
      httpStatus: 409,
      permanent: true,
    } as never);
    const out = await leaveGroupOnFamilyAsk({ chatId: CHAT, explicitAsk: true }, p.ports);
    expect(out).toEqual({ status: 'failed', reason: '2013' });
  });
});
