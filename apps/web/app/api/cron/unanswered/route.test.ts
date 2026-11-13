import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sweepUnansweredMessagesMock = vi.fn();
const pageUnansweredParentTextsMock = vi.fn();
const pager = { page: vi.fn() };

vi.mock('~/lib/analytics/unanswered', () => ({
  sweepUnansweredMessages: (...args: unknown[]) => sweepUnansweredMessagesMock(...args),
  pageUnansweredParentTexts: (...args: unknown[]) => pageUnansweredParentTextsMock(...args),
}));
vi.mock('~/lib/monitoring/failure-page', () => ({ failurePageOpsPager: () => pager }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const SECRET = 'test-cron-secret';

function request(headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }): Request {
  return new Request('https://app.example.com/api/cron/unanswered', { headers });
}

describe('GET /api/cron/unanswered', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    sweepUnansweredMessagesMock.mockReset();
    pageUnansweredParentTextsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'CRON_SECRET');
  });

  it('answers 401 and does nothing without the secret', async () => {
    const { GET } = await import('./route');

    const response = await GET(request({}));

    expect(response.status).toBe(401);
    expect(sweepUnansweredMessagesMock).not.toHaveBeenCalled();
    expect(pageUnansweredParentTextsMock).not.toHaveBeenCalled();
  });

  it('pages through the ops pager, runs the sweep, and answers both', async () => {
    const { GET } = await import('./route');
    pageUnansweredParentTextsMock.mockResolvedValue({ unanswered: 1, page: 'paged' });
    sweepUnansweredMessagesMock.mockResolvedValue({ scanned: 2, emitted: 1, skipped: null });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      scanned: 2,
      emitted: 1,
      skipped: null,
      page: { unanswered: 1, page: 'paged' },
    });
    expect(pageUnansweredParentTextsMock).toHaveBeenCalledWith({}, pager);
    expect(sweepUnansweredMessagesMock).toHaveBeenCalledTimes(1);
  });
});
