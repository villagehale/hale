import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorAlert } from '~/lib/channel/twilio/triage';
import {
  TRIAGE_CLAIM_ROUTE,
  TRIAGE_DIGEST_WINDOW_MS,
  type TwilioTriageDeps,
  advanceTriageCursor,
  claimTriageDigestWindow,
  fetchMonitorAlerts,
  loadTriageCursor,
  resetTriageInstanceWindowForTests,
  runTwilioTriage,
} from './twilio-triage';

/**
 * VIL-331 · the alert-triage cron's orchestration: cursor filtering, the 30-minute
 * digest window, and every rule-#11 outcome. The Twilio fetch, the SMS send and the
 * three rate_limits store calls are injected; the store functions themselves are
 * tested below against a captured drizzle chain, the same way provider-health tests
 * claimProviderIncident.
 */

const NOW = new Date('2026-08-28T13:10:00Z');

function webhookAlert(dateCreated: string, httpResponse = '500'): MonitorAlert {
  return {
    sid: `NO-${dateCreated}`,
    alert_text: `Msg=HTTP+retrieval+failure&sourceComponent=14100&httpResponse=${httpResponse}&url=https%3A%2F%2Fapp.villagehale.com%2Fapi%2Fchannels%2Ftwilio%2Finbound&ErrorCode=11200`,
    date_created: dateCreated,
    error_code: '11200',
    log_level: 'error',
    request_method: 'POST',
    request_url: 'https://app.villagehale.com/api/channels/twilio/inbound',
  };
}

/** An error alert about something OTHER than our webhooks (e.g. a carrier error on
 * an outbound send) — triage must leave it alone. */
function otherAlert(dateCreated: string): MonitorAlert {
  return {
    sid: `NO-other-${dateCreated}`,
    alert_text: 'Msg=Message+filtered&ErrorCode=30007',
    date_created: dateCreated,
    error_code: '30007',
    log_level: 'error',
    request_url: null,
  };
}

/** The paged read's success shape: these alerts, nothing left unread behind them. */
function scanned(alerts: MonitorAlert[]) {
  return { ok: true as const, data: { alerts, truncated: false } };
}

interface DepsOverrides extends Partial<TwilioTriageDeps> {}

function deps(overrides: DepsOverrides = {}): TwilioTriageDeps {
  return {
    configured: () => ({ ok: true }),
    fetchAlerts: vi.fn(async () =>
      scanned([webhookAlert('2026-08-28T13:02:11Z'), webhookAlert('2026-08-28T13:04:20Z')]),
    ),
    loadCursor: vi.fn(async () => null),
    advanceCursor: vi.fn(async () => {}),
    claimWindow: vi.fn(async () => true),
    outboundSentCount: vi.fn(async () => 3),
    sendSms: vi.fn(async () => 'sent' as const),
    escalateDigestFailure: vi.fn(async () => {}),
    ...overrides,
  };
}

const database = {} as Database;

beforeEach(() => {
  resetTriageInstanceWindowForTests();
});

describe('runTwilioTriage', () => {
  it('skips with the missing names before touching Twilio or the phone', async () => {
    const d = deps({ configured: () => ({ ok: false, missing: ['FOUNDER_ALERT_PHONE'] }) });
    const result = await runTwilioTriage(database, d, NOW);
    expect(result).toEqual({ outcome: 'skipped_not_configured', missing: ['FOUNDER_ALERT_PHONE'] });
    expect(d.fetchAlerts).not.toHaveBeenCalled();
    expect(d.sendSms).not.toHaveBeenCalled();
  });

  it('names an unreachable Monitor API instead of reporting a quiet webhook', async () => {
    const d = deps({
      fetchAlerts: vi.fn(async () => ({
        ok: false as const,
        status: 'unreachable' as const,
        detail: 'Twilio answered 503',
      })),
    });
    const result = await runTwilioTriage(database, d, NOW);
    expect(result).toEqual({ outcome: 'monitor_unreachable', detail: 'Twilio answered 503' });
    expect(d.sendSms).not.toHaveBeenCalled();
  });

  it('sends the diagnosis digest on new webhook alerts, claims the window, advances the cursor', async () => {
    const d = deps();
    const result = await runTwilioTriage(database, d, NOW);

    expect(d.sendSms).toHaveBeenCalledTimes(1);
    const body = (d.sendSms as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(body).toContain('inbound webhook failing');
    expect(body).toContain('2 alerts');
    expect(body).toContain('Outbound OK');

    expect(d.claimWindow).toHaveBeenCalledWith(database, NOW);
    // Cursor lands on the NEWEST alert seen, so the next poll starts after it.
    expect(d.advanceCursor).toHaveBeenCalledWith(database, new Date('2026-08-28T13:04:20Z'));
    expect(result).toMatchObject({
      outcome: 'digest_sent',
      alerts: 2,
      class: 'crash_5xx',
      likelyLayer: 'db_or_connection',
      rateLimitStore: 'ok',
      cursor: 'advanced',
    });
  });

  it('a second poll from the advanced cursor finds nothing new and stays quiet', async () => {
    const d = deps({ loadCursor: vi.fn(async () => new Date('2026-08-28T13:04:20Z')) });
    const result = await runTwilioTriage(database, d, NOW);
    // Boundary is strict: the alert AT the cursor was already reported.
    expect(result).toMatchObject({ outcome: 'no_new_alerts' });
    expect(d.sendSms).not.toHaveBeenCalled();
    expect(d.advanceCursor).not.toHaveBeenCalled();
  });

  it('without a cursor, only the trailing lookback hour is eligible — no replaying old incidents', async () => {
    const d = deps({
      fetchAlerts: vi.fn(async () =>
        scanned([webhookAlert('2026-08-28T11:59:00Z'), webhookAlert('2026-08-28T13:02:11Z')]),
      ),
    });
    const result = await runTwilioTriage(database, d, NOW);
    expect(result).toMatchObject({ outcome: 'digest_sent', alerts: 1 });
  });

  it('suppresses when another run already claimed this 30-min window, keeping the alerts pending', async () => {
    const d = deps({ claimWindow: vi.fn(async () => false) });
    const result = await runTwilioTriage(database, d, NOW);
    expect(result).toEqual({
      outcome: 'suppressed_rate_limit',
      source: 'claim',
      pendingAlerts: 2,
    });
    expect(d.sendSms).not.toHaveBeenCalled();
    // Not advanced: the suppressed alerts roll into the next window's digest.
    expect(d.advanceCursor).not.toHaveBeenCalled();
  });

  it('still pages when the claim store is the sick DB, braked only by the instance window', async () => {
    const claimWindow = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const d = deps({ claimWindow });

    const first = await runTwilioTriage(database, d, NOW);
    expect(first).toMatchObject({ outcome: 'digest_sent', rateLimitStore: 'unavailable' });
    expect(d.sendSms).toHaveBeenCalledTimes(1);

    const second = await runTwilioTriage(database, d, new Date(NOW.getTime() + 10 * 60_000));
    expect(second).toMatchObject({ outcome: 'suppressed_rate_limit', source: 'instance_window' });
    expect(d.sendSms).toHaveBeenCalledTimes(1);
  });

  it('a refused SMS is digest_send_failed, escalated over the other transport, cursor stays for a retry', async () => {
    const d = deps({ sendSms: vi.fn(async () => 'failed' as const) });
    const result = await runTwilioTriage(database, d, NOW);
    expect(result).toMatchObject({ outcome: 'digest_send_failed', alerts: 2, class: 'crash_5xx' });
    expect(d.advanceCursor).not.toHaveBeenCalled();
    // The page said webhooks are failing; the page's own failure must not end as a
    // console line — it goes through the provider-health seam (founder email).
    expect(d.escalateDigestFailure).toHaveBeenCalledWith(database, 'provider_error', NOW);
  });

  it('a not-configured SMS leg is a named skip, never escalated as an incident', async () => {
    const d = deps({ sendSms: vi.fn(async () => 'skipped_not_configured' as const) });
    const result = await runTwilioTriage(database, d, NOW);
    expect(result).toMatchObject({ outcome: 'skipped_not_configured' });
    expect(d.escalateDigestFailure).not.toHaveBeenCalled();
  });

  it('non-webhook alerts are counted, skipped, and the cursor moves past them', async () => {
    const d = deps({
      fetchAlerts: vi.fn(async () =>
        scanned([otherAlert('2026-08-28T13:05:00Z'), otherAlert('2026-08-28T13:06:00Z')]),
      ),
    });
    const result = await runTwilioTriage(database, d, NOW);
    expect(result).toMatchObject({ outcome: 'no_new_alerts', ignoredOtherAlerts: 2, cursor: 'advanced' });
    expect(d.advanceCursor).toHaveBeenCalledWith(database, new Date('2026-08-28T13:06:00Z'));
    expect(d.sendSms).not.toHaveBeenCalled();
  });

  it('a failed outbound probe becomes "Outbound unchecked", never a health claim', async () => {
    const d = deps({
      outboundSentCount: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    await runTwilioTriage(database, d, NOW);
    const body = (d.sendSms as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(body).toContain('Outbound unchecked');
  });

  it('a broken cursor store degrades to the lookback window and names the cursor outcome', async () => {
    const d = deps({
      loadCursor: vi.fn(async () => {
        throw new Error('db down');
      }),
      advanceCursor: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const result = await runTwilioTriage(database, d, NOW);
    expect(result).toMatchObject({ outcome: 'digest_sent', cursor: 'store_unavailable' });
    expect(d.sendSms).toHaveBeenCalledTimes(1);
  });
});

// ── the paged Monitor read ───────────────────────────────────────────────────

/**
 * The gap this suite exists for: Twilio answers with ONE page of 50, newest first,
 * and a burst of alerts about something else (a 30007 carrier-filter storm) fills it
 * in minutes. Reading page one alone and then advancing the cursor past it steps
 * over every webhook failure sitting on page two — silently, forever.
 *
 * So the paging is exercised for real here: `fetchMonitorAlerts` against a fake
 * Twilio that links its pages with the `meta.next_page_url` the Monitor API actually
 * returns, wired into a real run.
 */

/** A fake Monitor Alerts endpoint serving `pages` newest-first, each linked to the
 * next by an absolute URL derived from the request — so the code under test must
 * FOLLOW what the server said, not re-derive it. */
function pagedMonitor(pages: MonitorAlert[][]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('Page') ?? '0');
    const next = new URL(url);
    next.searchParams.set('Page', String(page + 1));
    return new Response(
      JSON.stringify({
        alerts: pages[page] ?? [],
        meta: { next_page_url: page + 1 < pages.length ? next.toString() : null },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

/** `n` carrier-error alerts, newest first, `offset` seconds before NOW. */
function carrierStorm(n: number, offset: number): MonitorAlert[] {
  return Array.from({ length: n }, (_, i) =>
    otherAlert(new Date(NOW.getTime() - (offset + i + 1) * 1_000).toISOString()),
  );
}

describe('the Monitor scan follows pages', () => {
  beforeEach(() => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC-test');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a burst filling page one cannot hide the webhook failure on page two', async () => {
    const monitor = pagedMonitor([carrierStorm(50, 0), [webhookAlert('2026-08-28T13:03:00Z')]]);
    const d = deps({
      fetchAlerts: (since) => fetchMonitorAlerts(monitor as unknown as typeof fetch, since),
    });

    const result = await runTwilioTriage(database, d, NOW);

    expect(d.sendSms).toHaveBeenCalledTimes(1);
    const body = (d.sendSms as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(body).toContain('inbound webhook failing');
    expect(result).toMatchObject({
      outcome: 'digest_sent',
      alerts: 1,
      class: 'crash_5xx',
      scan: 'complete',
    });
    expect(monitor).toHaveBeenCalledTimes(2);
  });

  it('stops at the page cap, names the truncated scan, and holds the cursor at the oldest alert it read', async () => {
    const monitor = pagedMonitor(
      Array.from({ length: 6 }, (_, page) => carrierStorm(50, page * 50)),
    );
    const d = deps({
      fetchAlerts: (since) => fetchMonitorAlerts(monitor as unknown as typeof fetch, since),
    });

    const result = await runTwilioTriage(database, d, NOW);

    expect(monitor).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({
      outcome: 'no_new_alerts',
      ignoredOtherAlerts: 250,
      scan: 'truncated_scan',
      cursor: 'advanced',
    });
    // The sixth page was never read, so the cursor may not step past the 250th alert.
    expect(d.advanceCursor).toHaveBeenCalledWith(database, new Date(NOW.getTime() - 250 * 1_000));
  });

  it('reads one page when it already reaches alerts the cursor covers', async () => {
    const monitor = pagedMonitor([carrierStorm(50, 0), carrierStorm(50, 50)]);
    const d = deps({
      loadCursor: vi.fn(async () => new Date(NOW.getTime() - 10 * 1_000)),
      fetchAlerts: (since) => fetchMonitorAlerts(monitor as unknown as typeof fetch, since),
    });

    const result = await runTwilioTriage(database, d, NOW);

    expect(monitor).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'no_new_alerts', ignoredOtherAlerts: 9, scan: 'complete' });
  });
});

// ── the rate_limits store functions ──────────────────────────────────────────

interface StoreCapture {
  inserted: Array<{ identifier: string; route: string; windowStart: Date; count: number }>;
  deletes: number;
}

function fakeStoreDb(opts: { alreadyClaimed?: boolean; cursorRows?: Array<{ windowStart: Date }> } = {}): {
  database: Database;
  capture: StoreCapture;
} {
  const capture: StoreCapture = { inserted: [], deletes: 0 };
  const database = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => opts.cursorRows ?? [],
          }),
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        capture.deletes += 1;
      },
    }),
    insert: () => ({
      values: (row: StoreCapture['inserted'][number]) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            capture.inserted.push(row);
            return opts.alreadyClaimed ? [] : [{ id: 'row' }];
          },
        }),
      }),
    }),
  } as unknown as Database;
  return { database, capture };
}

describe('claimTriageDigestWindow', () => {
  it('claims once per 30-minute window, floored to the window boundary', async () => {
    const { database: db, capture } = fakeStoreDb();
    const won = await claimTriageDigestWindow(db, new Date('2026-08-28T13:47:00Z'));
    expect(won).toBe(true);
    expect(capture.inserted).toEqual([
      {
        identifier: 'digest',
        route: TRIAGE_CLAIM_ROUTE,
        windowStart: new Date('2026-08-28T13:30:00Z'),
        count: 1,
      },
    ]);
    expect(TRIAGE_DIGEST_WINDOW_MS).toBe(30 * 60_000);
  });

  it('loses when this window was already claimed', async () => {
    const { database: db } = fakeStoreDb({ alreadyClaimed: true });
    expect(await claimTriageDigestWindow(db, new Date('2026-08-28T13:47:00Z'))).toBe(false);
  });
});

describe('triage cursor store', () => {
  it('advance writes the cursor row and sweeps older cursor rows', async () => {
    const { database: db, capture } = fakeStoreDb();
    await advanceTriageCursor(db, new Date('2026-08-28T13:04:20Z'));
    expect(capture.inserted).toEqual([
      {
        identifier: 'cursor',
        route: TRIAGE_CLAIM_ROUTE,
        windowStart: new Date('2026-08-28T13:04:20Z'),
        count: 0,
      },
    ]);
    expect(capture.deletes).toBe(1);
  });

  it('load returns the stored cursor, or null before the first advance', async () => {
    const at = new Date('2026-08-28T13:04:20Z');
    const { database: withRow } = fakeStoreDb({ cursorRows: [{ windowStart: at }] });
    expect(await loadTriageCursor(withRow)).toEqual(at);

    const { database: empty } = fakeStoreDb();
    expect(await loadTriageCursor(empty)).toBeNull();
  });
});
