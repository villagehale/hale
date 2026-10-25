import { describe, expect, it, vi } from 'vitest';
import { BrowserUseApiError } from '../client';
import { browserUseWatchApi, browserUseWatchApiFromEnv, usd } from './api';
import { sameProviderHost } from './context';
import { browserUseWatchEnabled } from './flag';
import { parseWatchOutput } from './outcome';
import { browserUseWatchDepsFromEnv } from './runner';
import { watchFacts, watchScriptPath } from './sweep';

describe('browser use watch flag', () => {
  it('is on only for exactly `true`', () => {
    expect(browserUseWatchEnabled({})).toBe(false);
    for (const value of ['', 'on', '1', 'TRUE', 'true\n', ' true', 'yes']) {
      expect(browserUseWatchEnabled({ BROWSER_USE_WATCH_ENABLED: value }), value).toBe(false);
    }
    expect(browserUseWatchEnabled({ BROWSER_USE_WATCH_ENABLED: 'true' })).toBe(true);
  });
});

describe('browser use watch api', () => {
  it('names a missing key and builds without calling the network', () => {
    expect(browserUseWatchApiFromEnv({})).toEqual({ api: null, skipped: 'not_configured' });
    expect(browserUseWatchDepsFromEnv({ BROWSER_USE_API_KEY: '  ' })).toBeNull();
    const fetchImpl = vi.fn();
    expect(browserUseWatchDepsFromEnv({ BROWSER_USE_API_KEY: 'k' }, fetchImpl)).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the key header, the workspace, model and proxy settings', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/workspaces')) return Response.json({ id: 'ws-1' });
      if (url.endsWith('/runs')) return Response.json({ id: 'run-1', sessionId: 's-1' });
      if (url.endsWith('/sessions/s-1/cost')) return Response.json({ totalCostUsd: '0.0420' });
      return new Response('nope', { status: 500 });
    });
    const api = browserUseWatchApi({ apiKey: 'test-key', fetch: fetchImpl });
    expect(await api.createWorkspace('hale-watch x')).toEqual({ id: 'ws-1' });
    await api.createRun({
      task: 't',
      outputSchema: {},
      workspaceId: 'ws-1',
      model: 'gpt-6-luna',
      modelParams: { reasoning: { effort: 'medium' } },
      maxCostUsd: 0.1,
      agentmail: false,
      browserSettings: { proxyCountryCode: null, record: false },
    });
    expect(await api.getSessionCostUsd('s-1')).toBeCloseTo(0.042);
    const run = calls.find((c) => c.url.endsWith('/runs'));
    expect(run?.url).toBe('https://api.browser-use.com/api/v4/runs');
    expect((run?.init.headers as Record<string, string>)['X-Browser-Use-API-Key']).toBe('test-key');
    expect(JSON.parse(String(run?.init.body))).toMatchObject({
      workspaceId: 'ws-1',
      model: 'gpt-6-luna',
      modelParams: { reasoning: { effort: 'medium' } },
      browserSettings: { proxyCountryCode: null, record: false },
      agentmail: false,
    });
    await expect(api.getRun('x')).rejects.toBeInstanceOf(BrowserUseApiError);
  });

  it('reads dollar strings and rejects junk', () => {
    expect(usd('0.0123')).toBeCloseTo(0.0123);
    expect(usd(2)).toBe(2);
    expect(usd('abc')).toBeNull();
    expect(usd(-1)).toBeNull();
    expect(usd(undefined)).toBeNull();
  });
});

describe('watch output', () => {
  it('keeps well-formed items, drops malformed ones, caps lengths and count', () => {
    const parsed = parseWatchOutput({
      page_reached: true,
      script_saved: true,
      fetched_at: '2026-10-25T10:00:00Z',
      items: [
        { title: 'Preschool Swim', status: 'waitlist', spots_left: null, ages: '3-5' },
        { title: 'Bad', status: 'maybe' },
        { status: 'open' },
        { title: 'x'.repeat(500), status: 'open', spots_left: 4 },
        ...Array.from({ length: 40 }, (_, i) => ({ title: `S${i}`, status: 'full' })),
      ],
    });
    expect(parsed?.items[0]).toMatchObject({
      title: 'Preschool Swim',
      status: 'waitlist',
      ages: '3-5',
    });
    expect(parsed?.items[1]?.title.length).toBe(200);
    expect(parsed?.items[1]?.spots_left).toBe(4);
    expect(parsed?.items.length).toBe(25);
  });

  it('accepts a JSON string and refuses the wrong shape', () => {
    expect(
      parseWatchOutput('{"page_reached":false,"script_saved":false,"items":[]}'),
    ).toMatchObject({
      pageReached: false,
      items: [],
    });
    expect(parseWatchOutput('not json')).toBeNull();
    expect(parseWatchOutput({ items: [] })).toBeNull();
    expect(parseWatchOutput(null)).toBeNull();
  });
});

describe('watch facts', () => {
  it('names one stable script per page and kind, and the mode', () => {
    const target = {
      sourceUrl: 'https://cityofx.perfectmind.com/Clients/BookMe4?x=1',
      kind: 'openings' as const,
      providerHost: 'cityofx.perfectmind.com',
    };
    expect(watchScriptPath(target)).toMatch(/^scripts\/openings-[0-9a-f]{10}\.py$/);
    expect(watchScriptPath(target)).toBe(watchScriptPath({ ...target }));
    expect(watchScriptPath({ ...target, kind: 'waitlist' })).not.toBe(watchScriptPath(target));
    expect(watchFacts(target, false).mode).toBe('create');
    expect(watchFacts(target, true).mode).toBe('rerun');
  });

  it('matches provider hosts across subdomains only', () => {
    expect(sameProviderHost('cityofx.perfectmind.com', 'perfectmind.com')).toBe(true);
    expect(sameProviderHost('PerfectMind.com.', 'perfectmind.com')).toBe(true);
    expect(sameProviderHost('notperfectmind.com', 'perfectmind.com')).toBe(false);
    expect(sameProviderHost('a.example.ca', 'b.example.ca')).toBe(false);
  });
});
