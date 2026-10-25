import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { browserUseWatchApi } from './api';
import { loadProviderWatchContext } from './context';
import {
  WATCH_DAY_MAX_COST_USD,
  WATCH_MAX_RUNS_PER_SWEEP,
  WATCH_RUN_MAX_COST_USD,
  WATCH_RUN_RESERVE_USD,
  type WatchSweepDeps,
  runBrowserUseWatchSweep,
} from './sweep';

/**
 * Mocked fetch only. Every Browser Use call goes through the real REST client into a
 * recorded-shape fake; no key is set and nothing leaves the process.
 */
const NOW = new Date('2026-10-25T14:00:00.000Z');
const HOST = 'cityofx.perfectmind.com';
const PAGE = `https://${HOST}/Clients/BookMe4?courseId=swim`;

interface FakeOptions {
  output?: unknown;
  status?: 'completed' | 'failed' | 'running';
  sessionCost?: string | null;
  runCost?: string | null;
}

function fakeBrowserUse(options: FakeOptions = {}) {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> =
    [];
  let runs = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.browser-use.com/api/v4', '');
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ method: init.method ?? 'GET', path, body });
    if (path === '/workspaces') return Response.json({ id: 'ws-1', name: body?.name });
    if (path === '/runs') {
      runs += 1;
      return Response.json({ id: `run-${runs}`, sessionId: `sess-${runs}` });
    }
    if (/^\/runs\/[^/]+\/status$/.test(path)) {
      return Response.json({ status: options.status ?? 'completed' });
    }
    if (/^\/runs\/[^/]+\/cancel$/.test(path)) return new Response(null, { status: 204 });
    if (/^\/runs\/[^/]+$/.test(path)) {
      const id = path.split('/')[2] ?? '';
      return Response.json({
        id,
        status: options.status ?? 'completed',
        sessionId: id.replace('run', 'sess'),
        output: options.output ?? {
          page_reached: true,
          script_saved: true,
          fetched_at: NOW.toISOString(),
          items: [{ title: 'Preschool Swim Sat 9am', status: 'waitlist', spots_left: null }],
        },
        totalCostUsd: options.runCost ?? '0.0200',
      });
    }
    if (/^\/sessions\/[^/]+\/cost$/.test(path)) {
      return options.sessionCost === null
        ? new Response('gone', { status: 404 })
        : Response.json({ totalCostUsd: options.sessionCost ?? '0.0500' });
    }
    return new Response('unexpected', { status: 500 });
  });
  return { fetchImpl, requests };
}

describe('browser use watch sweep', () => {
  let db: TestDb;
  let clock: Date;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    clock = NOW;
    for (const key of [
      'BROWSER_USE_API_KEY',
      'ANTHROPIC_API_KEY',
      'AI_GATEWAY_API_KEY',
      'LINQ_API_KEY',
      'DATABASE_URL',
    ]) {
      vi.stubEnv(key, '');
    }
    await db.database.delete(schema.providerWatchReadings);
    await db.database.delete(schema.providerWatchTargets);
    await db.database.delete(schema.providerWatchWorkspaces);
  });

  function deps(fetchImpl: ReturnType<typeof fakeBrowserUse>['fetchImpl']): WatchSweepDeps {
    return {
      api: browserUseWatchApi({ apiKey: 'fixture-key', fetch: fetchImpl }),
      loadTask: async () => 'Read the page.',
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
      now: () => clock,
    };
  }

  async function target(overrides: Partial<typeof schema.providerWatchTargets.$inferInsert> = {}) {
    const family = await seedFamily(db.database);
    const [row] = await db.database
      .insert(schema.providerWatchTargets)
      .values({
        providerHost: HOST,
        sourceUrl: PAGE,
        kind: 'waitlist',
        nextRunAt: new Date(NOW.getTime() - 60_000),
        ...overrides,
      })
      .returning();
    if (!row) throw new Error('no target');
    // The sweep runs only targets a family agreed to.
    await db.database.insert(schema.familyWatchSubscriptions).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      targetId: row.id,
      sourceRef: 'spot:fixture',
      consentConversationId: 'conv-fixture',
      consentMessageSha256: 'a'.repeat(64),
      consentQuote: 'yes please',
    });
    return row;
  }

  it('does nothing with the flag off or the key unset', async () => {
    await target();
    const fake = fakeBrowserUse();
    expect(await runBrowserUseWatchSweep(db.database, deps(fake.fetchImpl), false)).toEqual({
      skipped: 'flag_off',
    });
    expect(await runBrowserUseWatchSweep(db.database, null, true)).toEqual({
      skipped: 'not_configured',
    });
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(await db.database.select().from(schema.providerWatchReadings)).toEqual([]);
  });

  it('creates one workspace per provider, saves the script, then reruns it', async () => {
    const first = await target();
    const fake = fakeBrowserUse();
    const result = await runBrowserUseWatchSweep(db.database, deps(fake.fetchImpl), true);
    expect(result).toMatchObject({ skipped: null, ran: 1, outcomes: ['read'] });

    const createRun = fake.requests.find((r) => r.path === '/runs');
    expect(createRun?.body).toMatchObject({
      workspaceId: 'ws-1',
      model: 'gpt-6-luna',
      modelParams: { reasoning: { effort: 'medium' } },
      maxCostUsd: WATCH_RUN_MAX_COST_USD,
      agentmail: false,
      browserSettings: { proxyCountryCode: null, record: false },
    });
    expect(String(createRun?.body?.task)).toContain('"mode": "create"');

    const [workspace] = await db.database.select().from(schema.providerWatchWorkspaces);
    expect(workspace).toMatchObject({ providerHost: HOST, browserUseWorkspaceId: 'ws-1' });
    expect(workspace?.scriptSavedAt).not.toBeNull();

    const [reading] = await db.database.select().from(schema.providerWatchReadings);
    expect(reading).toMatchObject({ outcome: 'read', runId: 'run-1', sessionId: 'sess-1' });
    // The session's full cost, not the run's model-only cost.
    expect(Number(reading?.costUsd)).toBeCloseTo(0.05);
    const [moved] = await db.database
      .select()
      .from(schema.providerWatchTargets)
      .where(eq(schema.providerWatchTargets.id, first.id));
    expect(moved?.nextRunAt.getTime()).toBe(NOW.getTime() + 360 * 60_000);

    // A second page on the same provider reuses the workspace and reruns the script.
    await target({ sourceUrl: `${PAGE}-2`, kind: 'openings', useProxy: true });
    const again = fakeBrowserUse();
    await runBrowserUseWatchSweep(db.database, deps(again.fetchImpl), true);
    expect(again.requests.some((r) => r.path === '/workspaces')).toBe(false);
    const rerun = again.requests.find((r) => r.path === '/runs');
    expect(String(rerun?.body?.task)).toContain('"mode": "rerun"');
    expect(rerun?.body?.browserSettings).toEqual({ proxyCountryCode: 'ca', record: false });
  });

  it('stops at the per-sweep run cap', async () => {
    for (let i = 0; i < WATCH_MAX_RUNS_PER_SWEEP + 2; i += 1) {
      await target({ sourceUrl: `${PAGE}&n=${i}` });
    }
    const fake = fakeBrowserUse();
    const result = await runBrowserUseWatchSweep(db.database, deps(fake.fetchImpl), true);
    expect(result).toMatchObject({ ran: WATCH_MAX_RUNS_PER_SWEEP, stoppedBy: 'run_cap' });
    expect(fake.requests.filter((r) => r.path === '/runs')).toHaveLength(WATCH_MAX_RUNS_PER_SWEEP);
  });

  it('starts no run once the last 24 hours of spend would pass the day cap', async () => {
    const t = await target();
    await db.database.insert(schema.providerWatchReadings).values({
      targetId: t.id,
      providerHost: HOST,
      outcome: 'read',
      costUsd: (WATCH_DAY_MAX_COST_USD - 0.05).toFixed(4),
      readAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    const fake = fakeBrowserUse();
    const result = await runBrowserUseWatchSweep(db.database, deps(fake.fetchImpl), true);
    expect(result).toMatchObject({ ran: 0, stoppedBy: 'day_cap' });
    expect(fake.fetchImpl).not.toHaveBeenCalled();
  });

  it('counts spend older than 24 hours out of the day cap', async () => {
    const t = await target();
    await db.database.insert(schema.providerWatchReadings).values({
      targetId: t.id,
      providerHost: HOST,
      outcome: 'read',
      costUsd: WATCH_DAY_MAX_COST_USD.toFixed(4),
      readAt: new Date(NOW.getTime() - 25 * 60 * 60_000),
    });
    const result = await runBrowserUseWatchSweep(
      db.database,
      deps(fakeBrowserUse().fetchImpl),
      true,
    );
    expect(result).toMatchObject({ ran: 1 });
  });

  it('cancels a run past its deadline and records it as failed with its cost', async () => {
    await target();
    const fake = fakeBrowserUse({ status: 'running' });
    const result = await runBrowserUseWatchSweep(db.database, deps(fake.fetchImpl), true);
    expect(result).toMatchObject({ outcomes: ['timeout'] });
    expect(fake.requests.some((r) => r.path === '/runs/run-1/cancel')).toBe(true);
    const [reading] = await db.database.select().from(schema.providerWatchReadings);
    expect(reading?.outcome).toBe('failed');
    expect(Number(reading?.costUsd)).toBeGreaterThan(0);
  });

  it('skips a target no family is subscribed to, or whose subscription was removed', async () => {
    const t = await target();
    await db.database
      .update(schema.familyWatchSubscriptions)
      .set({ removedAt: NOW })
      .where(eq(schema.familyWatchSubscriptions.targetId, t.id));
    const fake = fakeBrowserUse();
    expect(await runBrowserUseWatchSweep(db.database, deps(fake.fetchImpl), true)).toMatchObject({
      ran: 0,
    });
    expect(fake.fetchImpl).not.toHaveBeenCalled();
  });

  it('a throw after the run exists still cancels it and books the reserve against the day cap', async () => {
    await target();
    const fake = fakeBrowserUse();
    const inner = fake.fetchImpl.getMockImplementation();
    fake.fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      // A 200 whose body is not JSON: a SyntaxError, not a BrowserUseApiError.
      if (url.endsWith('/runs/run-1')) return new Response('<html>', { status: 200 });
      return inner!(url, init);
    });
    const result = await runBrowserUseWatchSweep(db.database, deps(fake.fetchImpl), true);
    expect(result).toMatchObject({ outcomes: ['api_error'] });
    expect(fake.requests.some((r) => r.path === '/runs/run-1/cancel')).toBe(true);
    const [reading] = await db.database.select().from(schema.providerWatchReadings);
    expect(reading).toMatchObject({ outcome: 'failed', runId: 'run-1' });
    expect(Number(reading?.costUsd)).toBeCloseTo(WATCH_RUN_RESERVE_USD);
  });

  it('records an unreadable page and falls back to the run cost', async () => {
    await target();
    const fake = fakeBrowserUse({
      output: { page_reached: false, script_saved: false, items: [] },
      sessionCost: null,
      runCost: '0.0300',
    });
    const result = await runBrowserUseWatchSweep(db.database, deps(fake.fetchImpl), true);
    expect(result).toMatchObject({ outcomes: ['unreadable'] });
    const [reading] = await db.database.select().from(schema.providerWatchReadings);
    expect(reading?.outcome).toBe('unreadable');
    expect(Number(reading?.costUsd)).toBeCloseTo(0.03);
    const [workspace] = await db.database.select().from(schema.providerWatchWorkspaces);
    expect(workspace?.scriptSavedAt).toBeNull();
  });

  it('hands the reading to the reply model only for this family’s providers, flag on', async () => {
    await target();
    await runBrowserUseWatchSweep(db.database, deps(fakeBrowserUse().fetchImpl), true);
    const family = await seedFamily(db.database);
    const other = await seedFamily(db.database, 'Other');
    await db.database.insert(schema.activityBookings).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: randomUUID(),
      messageId: 'msg-1',
      providerHost: 'perfectmind.com',
      title: 'Swim',
      firstSessionAt: NOW,
    });
    const on = { BROWSER_USE_WATCH_ENABLED: 'true' };

    const context = await loadProviderWatchContext(db.database, family.familyId, NOW, on);
    expect(context).toEqual([
      {
        provider: HOST,
        kind: 'waitlist',
        checkedAt: NOW.toISOString(),
        items: [expect.objectContaining({ title: 'Preschool Swim Sat 9am', status: 'waitlist' })],
      },
    ]);
    expect(await loadProviderWatchContext(db.database, other.familyId, NOW, on)).toEqual([]);
    expect(await loadProviderWatchContext(db.database, family.familyId, NOW, {})).toEqual([]);
    const later = new Date(NOW.getTime() + 8 * 24 * 60 * 60_000);
    expect(await loadProviderWatchContext(db.database, family.familyId, later, on)).toEqual([]);
  });
});
