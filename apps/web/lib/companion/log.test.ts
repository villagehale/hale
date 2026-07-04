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
vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: () => familyMock(),
  currentUserId: vi.fn().mockResolvedValue('user-1'),
  resolveUserIdForUser: vi.fn(),
}));
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

  it('persists a chosen past occurredAt (a parent logging something earlier)', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
    const earlier = '2026-06-18T08:30:00.000Z';
    const { logQuickEpisode } = await import('./log.js');

    const result = await logQuickEpisode(
      { kind: 'feed', childId: CHILD_ID, amountMl: 90, occurredAt: earlier },
      NOW,
    );

    expect(result.status).toBe('logged');
    expect(writeEpisodeMock.mock.calls[0]?.[1].occurredAt).toEqual(new Date(earlier));
  });

  it('defaults occurredAt to the request clock when omitted', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
    const { logQuickEpisode } = await import('./log.js');

    await logQuickEpisode({ kind: 'feed', childId: CHILD_ID, amountMl: 90 }, NOW);

    expect(writeEpisodeMock.mock.calls[0]?.[1].occurredAt).toEqual(NOW);
  });

  it('round-trips the feed kind through to the persisted episode', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
    const { logQuickEpisode } = await import('./log.js');

    await logQuickEpisode(
      { kind: 'feed', childId: CHILD_ID, amountMl: 120, feedKind: 'bottle' },
      NOW,
    );

    expect(writeEpisodeMock.mock.calls[0]?.[1]).toMatchObject({
      summary: 'Fed 120 ml (bottle)',
      payload: { amountMl: 120, feedKind: 'bottle' },
    });
  });

  it('round-trips a milestone note through to the persisted episode', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
    const { logQuickEpisode } = await import('./log.js');

    await logQuickEpisode(
      { kind: 'milestone', childId: CHILD_ID, milestone: 'first steps', note: 'in the kitchen' },
      NOW,
    );

    expect(writeEpisodeMock.mock.calls[0]?.[1].payload).toEqual({
      milestone: 'first steps',
      note: 'in the kitchen',
    });
  });

  it('rejects an occurredAt in the future (beyond clock skew) before any write', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    const { logQuickEpisode } = await import('./log.js');

    const result = await logQuickEpisode(
      { kind: 'feed', childId: CHILD_ID, amountMl: 90, occurredAt: future },
      NOW,
    );

    expect(result.status).toBe('invalid');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('rejects an absurdly old occurredAt before any write', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    const ancient = new Date(NOW.getTime() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const { logQuickEpisode } = await import('./log.js');

    const result = await logQuickEpisode(
      { kind: 'nap', childId: CHILD_ID, durationMin: 30, occurredAt: ancient },
      NOW,
    );

    expect(result.status).toBe('invalid');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });
});

describe('markCompanionItemDone', () => {
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

  it('writes an audited milestone episode and flips the item to done for its own child', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
    const { markCompanionItemDone } = await import('./log.js');

    const result = await markCompanionItemDone(
      { target: 'milestone', childId: CHILD_ID, what: 'Walks independently' },
      NOW,
    );

    expect(result.status).toBe('done');
    // The done-tap writes the SAME episode a quick-log milestone writes (rule #6
    // audit is inside writeEpisode, exercised in log-write.test).
    expect(writeEpisodeMock).toHaveBeenCalledTimes(1);
    expect(writeEpisodeMock.mock.calls[0]?.[1]).toMatchObject({
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      episodeType: 'milestone',
      summary: 'Walks independently',
      payload: { milestone: 'Walks independently' },
      occurredAt: NOW,
    });
    expect(revalidateMock).toHaveBeenCalledWith('/companion');
  });

  it('writes a health_done episode carrying the key when marking a checkup done', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
    const { markCompanionItemDone } = await import('./log.js');

    const result = await markCompanionItemDone(
      {
        target: 'health',
        childId: CHILD_ID,
        what: '4-month well-baby visit',
        healthKey: '4-well_child_visit',
      },
      NOW,
    );

    expect(result.status).toBe('done');
    expect(writeEpisodeMock.mock.calls[0]?.[1]).toMatchObject({
      episodeType: 'health_done',
      payload: { healthKey: '4-well_child_visit' },
    });
  });

  it('forbids marking an item done for a child not in the family — never writes', async () => {
    familyMock.mockResolvedValue(FAMILY_ID);
    childBelongsMock.mockResolvedValue(false);
    const { markCompanionItemDone } = await import('./log.js');

    const result = await markCompanionItemDone({
      target: 'milestone',
      childId: CHILD_ID,
      what: 'Walks independently',
    });

    expect(result.status).toBe('forbidden');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('returns preview without writing when no family resolves', async () => {
    familyMock.mockResolvedValue(null);
    const { markCompanionItemDone } = await import('./log.js');

    const result = await markCompanionItemDone({
      target: 'milestone',
      childId: CHILD_ID,
      what: 'Walks independently',
    });

    expect(result.status).toBe('preview');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed done input before any write', async () => {
    const { markCompanionItemDone } = await import('./log.js');
    const result = await markCompanionItemDone({ target: 'milestone', childId: 'not-a-uuid' });
    expect(result.status).toBe('invalid');
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });
});

