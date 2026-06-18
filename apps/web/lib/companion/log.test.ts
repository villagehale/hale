import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-06-18T12:00:00Z');

// logQuickEpisode / logBookingRequested read auth + db at request time; stub the
// edges so the tests exercise input validation + the family/child gating, not
// infra. The pure row-shape + transaction logic is covered in log-write.test.
const familyMock = vi.fn();
const childBelongsMock = vi.fn();
const writeEpisodeMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({ currentFamilyId: () => familyMock() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidateMock(p) }));
vi.mock('./log-write.js', async () => {
  const actual = await vi.importActual<typeof import('./log-write.js')>('./log-write.js');
  return {
    ...actual,
    childBelongsToFamily: (...args: unknown[]) => childBelongsMock(...args),
    writeEpisode: (...args: unknown[]) => writeEpisodeMock(...args),
  };
});

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

describe('logQuickEpisode', () => {
  beforeEach(() => {
    vi.resetModules();
    familyMock.mockReset();
    childBelongsMock.mockReset();
    writeEpisodeMock.mockReset();
    revalidateMock.mockReset();
    configureAuth(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a non-numeric / out-of-range amount before any write', async () => {
    const { logQuickEpisode } = await import('./log.js');

    const result = await logQuickEpisode({ kind: 'feed', childId: CHILD_ID, amountMl: -5 });

    expect(result.status).toBe('invalid');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('rejects a milestone with empty text', async () => {
    const { logQuickEpisode } = await import('./log.js');

    const result = await logQuickEpisode({
      kind: 'milestone',
      childId: CHILD_ID,
      milestone: '   ',
    });

    expect(result.status).toBe('invalid');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('forbids logging against a child not in the family — never writes', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(false);
    const { logQuickEpisode } = await import('./log.js');

    const result = await logQuickEpisode({ kind: 'feed', childId: CHILD_ID, amountMl: 120 });

    expect(result.status).toBe('forbidden');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('writes the episode and revalidates when the input is valid and the child is theirs', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
    const { logQuickEpisode } = await import('./log.js');

    const result = await logQuickEpisode({ kind: 'feed', childId: CHILD_ID, amountMl: 120 }, NOW);

    expect(result.status).toBe('logged');
    expect(writeEpisodeMock).toHaveBeenCalledTimes(1);
    expect(writeEpisodeMock.mock.calls[0]?.[1]).toMatchObject({
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      episodeType: 'feed',
      summary: 'Fed 120 ml',
      payload: { amountMl: 120 },
      occurredAt: NOW,
    });
    expect(revalidateMock).toHaveBeenCalledWith('/companion');
  });

  it('returns preview without writing when no family resolves', async () => {
    familyMock.mockResolvedValue(null);
    const { logQuickEpisode } = await import('./log.js');

    const result = await logQuickEpisode({ kind: 'nap', childId: CHILD_ID, durationMin: 30 });

    expect(result.status).toBe('preview');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });
});

describe('logBookingRequested', () => {
  beforeEach(() => {
    vi.resetModules();
    familyMock.mockReset();
    childBelongsMock.mockReset();
    writeEpisodeMock.mockReset();
    revalidateMock.mockReset();
    configureAuth(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records a booking_requested episode (intent, not a fake booking) for a family-wide request', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    writeEpisodeMock.mockResolvedValue(undefined);
    const { logBookingRequested } = await import('./log.js');

    const result = await logBookingRequested({ what: '6-month checkup' }, NOW);

    expect(result.status).toBe('requested');
    expect(writeEpisodeMock.mock.calls[0]?.[1]).toMatchObject({
      familyId: FAMILY_ID,
      childId: null,
      episodeType: 'booking_requested',
      summary: 'Asked Hale to help book: 6-month checkup',
      payload: { what: '6-month checkup' },
    });
  });

  it('forbids a booking against a child not in the family', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(false);
    const { logBookingRequested } = await import('./log.js');

    const result = await logBookingRequested({ what: 'checkup', childId: CHILD_ID });

    expect(result.status).toBe('forbidden');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });
});
