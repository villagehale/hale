import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The queue-maintenance cron door: nothing runs without the cron secret, the Linq
 * capacity watch runs after delivery health, and its outcome is on the response.
 */

const calls: string[] = [];
const checkDeliveryHealthMock = vi.fn();
const checkLinqCapacityMock = vi.fn();
const countLinqChatsMock = vi.fn();
const listLinqChatsPageStub = vi.fn();
const countDbChatIdsStub = vi.fn();
const latchStore = { latched: vi.fn(), claim: vi.fn(), confirm: vi.fn(), release: vi.fn() };

vi.mock('~/lib/cron/queue-maintenance', () => ({
  runQueueMaintenanceCron: async () => {
    calls.push('maintenance');
  },
}));
vi.mock('~/lib/channel/reconcile/unhanded', () => ({
  reconcileUnhandedInbound: async () => {
    calls.push('inbound');
    return { redriven: 0 };
  },
}));
vi.mock('~/lib/channel/claim-sweep', () => ({
  sweepUnconfirmedClaims: async () => {
    calls.push('claims');
    return { swept: 0 };
  },
}));
vi.mock('~/lib/channel/inbound-deps', () => ({ enqueueChannelMessageReceived: vi.fn() }));
vi.mock('~/lib/monitoring/delivery-health', () => ({
  checkDeliveryHealth: (...args: unknown[]) => {
    calls.push('health');
    return checkDeliveryHealthMock(...args);
  },
  claimDeliveryIncident: vi.fn(),
  loadDeliveryStats: vi.fn(),
}));
vi.mock('~/lib/monitoring/linq-capacity', () => ({
  checkLinqCapacity: (...args: unknown[]) => {
    calls.push('capacity');
    return checkLinqCapacityMock(...args);
  },
  countLinqChats: (...args: unknown[]) => countLinqChatsMock(...args),
  countDbChatIds: countDbChatIdsStub,
  rateLimitLatchStore: () => latchStore,
}));
vi.mock('~/lib/channel/linq/transport', () => ({ listLinqChatsPage: listLinqChatsPageStub }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const SECRET = 'test-cron-secret';

function request(headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }): Request {
  return new Request('https://app.example.com/api/cron/queue-maintenance', { headers });
}

describe('GET /api/cron/queue-maintenance', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    calls.length = 0;
    checkDeliveryHealthMock.mockReset();
    checkLinqCapacityMock.mockReset();
    countLinqChatsMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'CRON_SECRET');
  });

  it('answers 401 and runs no step without the secret, or with a wrong one', async () => {
    const { GET } = await import('./route');

    expect((await GET(request({}))).status).toBe(401);
    expect((await GET(request({ authorization: 'Bearer wrong' }))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('runs the capacity watch after delivery health and answers its outcome', async () => {
    const { GET } = await import('./route');
    checkDeliveryHealthMock.mockResolvedValue({ outcome: 'healthy', attempted: 0, failed: 0 });
    checkLinqCapacityMock.mockResolvedValue({ outcome: 'below', total: 12, rearmed: [] });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(calls).toEqual(['maintenance', 'inbound', 'claims', 'health', 'capacity']);
    expect(await response.json()).toEqual({
      ok: true,
      inbound: { redriven: 0 },
      claims: { swept: 0 },
      health: { outcome: 'healthy', attempted: 0, failed: 0 },
      capacity: { outcome: 'below', total: 12, rearmed: [] },
    });

    const [, deps, now] = checkLinqCapacityMock.mock.calls[0] ?? [];
    expect(deps.countDb).toBe(countDbChatIdsStub);
    expect(deps.latches).toBe(latchStore);
    expect(now).toBeInstanceOf(Date);
    await deps.countApi();
    expect(countLinqChatsMock).toHaveBeenCalledWith({ listPage: listLinqChatsPageStub });
  });

  it('does not run the capacity watch when delivery health throws', async () => {
    const { GET } = await import('./route');
    checkDeliveryHealthMock.mockRejectedValue(new Error('db down'));

    await expect(GET(request())).rejects.toThrow('db down');
    expect(calls).toEqual(['maintenance', 'inbound', 'claims', 'health']);
  });
});
