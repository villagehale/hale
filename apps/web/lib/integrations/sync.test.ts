import { describe, expect, it } from 'vitest';
import type { ActiveConnectorConnection } from './store';
import { type GoogleFetch, syncConnection } from './sync';
import type { OAuthTokens } from './token-vault';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FRESH: OAuthTokens = { accessToken: 'ya29.fresh', refreshToken: '1//refresh', expiresAt: Date.now() + 3600_000 };

/** Build a GoogleFetch that answers each requested URL from a route table (first
 * substring match), recording the bearer token it was called with. */
function routedFetch(routes: Array<{ match: string; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; token: string }> = [];
  const fetchImpl: GoogleFetch = async (url, accessToken) => {
    calls.push({ url, token: accessToken });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no route for ${url}`);
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => route.body };
  };
  return { fetchImpl, calls };
}

interface EnqueuedEvent {
  source: string;
  payload: Record<string, unknown>;
  familyId: string;
}

interface Captured {
  enqueued: EnqueuedEvent[];
  cursor?: Record<string, unknown>;
  errored: boolean;
  refreshed?: OAuthTokens;
}

/** The single enqueued event, asserting exactly one was emitted (narrows away the
 * noUncheckedIndexedAccess `undefined`). */
function onlyEvent(cap: Captured): EnqueuedEvent {
  expect(cap.enqueued).toHaveLength(1);
  const [event] = cap.enqueued;
  if (!event) throw new Error('no enqueued event');
  return event;
}

/** Deps stub: capture enqueue + cursor/error/token writes without a real queue/db. */
function stubDeps(overrides: Partial<Parameters<typeof syncConnection>[1]> = {}) {
  const cap: Captured = { enqueued: [], errored: false };
  const deps: Parameters<typeof syncConnection>[1] = {
    googleFetch: overrides.googleFetch ?? routedFetch([]).fetchImpl,
    enqueue: async (event) => {
      cap.enqueued.push({ source: event.source, payload: event.payload, familyId: event.family_id });
    },
    childNames: overrides.childNames ?? ['Mila'],
    saveCursor: async (_id, meta) => {
      cap.cursor = meta;
    },
    markError: async () => {
      cap.errored = true;
    },
    refreshTokens: overrides.refreshTokens ?? (async () => ({ accessToken: 'ya29.refreshed' })),
    saveTokens: async (_id, t) => {
      cap.refreshed = t;
    },
    ...overrides,
  };
  return { deps, cap };
}

function connection(provider: ActiveConnectorConnection['provider'], meta: Record<string, unknown> = {}, tokens = FRESH): ActiveConnectorConnection {
  return { id: 'i1', familyId: FAMILY, userId: USER, provider, providerMetadata: meta, tokens };
}

describe('syncConnection — Calendar', () => {
  it('maps events.list results → redacted events.ingested and advances syncToken', async () => {
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3/calendars/primary/events',
        body: {
          items: [
            { id: 'ev1', summary: 'Mila swim class', start: { dateTime: '2026-07-10T15:00:00Z' } },
          ],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(false);
    const event = onlyEvent(cap);
    expect(event.source).toBe('gcal');
    expect(event.familyId).toBe(FAMILY);
    // Redacted: the known child name is masked (rule #1).
    expect(JSON.stringify(event.payload)).not.toContain('Mila');
    expect(event.payload.summary).toBe('[CHILD] swim class');
    // Cursor advanced to the returned nextSyncToken.
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-2' });
  });

  it('on 410 GONE drops the stale syncToken and full-resyncs', async () => {
    let calls = 0;
    const fetchImpl: GoogleFetch = async (url) => {
      calls += 1;
      if (url.includes('syncToken=STALE')) {
        return { ok: false, status: 410, json: async () => ({ error: 'gone' }) };
      }
      // Full resync (no syncToken) succeeds.
      return { ok: true, status: 200, json: async () => ({ items: [], nextSyncToken: 'SYNC-FULL' }) };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'STALE' }), deps);

    expect(calls).toBe(2); // stale (410) then full resync
    expect(cap.errored).toBe(false);
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-FULL' });
  });
});

describe('syncConnection — Gmail', () => {
  it('first run: messages.list then per-message metadata; advances historyId', async () => {
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('/messages/m1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'm1',
            historyId: '9002',
            snippet: 'Reminder for Mila from daycare',
            payload: { headers: [{ name: 'Subject', value: 'Daycare note about Mila' }] },
          }),
        };
      }
      // messages.list (no historyId cursor yet on first run)
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1' }], historyId: '9002' }) };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gmail', {}), deps);

    expect(cap.errored).toBe(false);
    const event = onlyEvent(cap);
    expect(event.source).toBe('gmail');
    expect(JSON.stringify(event.payload)).not.toContain('Mila');
    // First run seeds the historyId cursor from the list response.
    expect(cap.cursor).toEqual({ historyId: '9002' });
  });

  it('incremental run: history.list from stored historyId; advances to the new historyId', async () => {
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('/messages/m2')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'm2', snippet: 'hello', payload: { headers: [{ name: 'Subject', value: 'Hi' }] } }),
        };
      }
      // history.list from startHistoryId
      return {
        ok: true,
        status: 200,
        json: async () => ({
          history: [{ messagesAdded: [{ message: { id: 'm2' } }] }],
          historyId: '9100',
        }),
      };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gmail', { historyId: '9002' }), deps);

    onlyEvent(cap);
    expect(cap.cursor).toEqual({ historyId: '9100' });
  });
});

describe('syncConnection — Drive', () => {
  it('first run: getStartPageToken then changes.list; advances pageToken', async () => {
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('changes/startPageToken')) {
        return { ok: true, status: 200, json: async () => ({ startPageToken: 'P1' }) };
      }
      // changes.list from P1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          changes: [{ file: { id: 'f1', name: 'Mila report card.pdf', mimeType: 'application/pdf' } }],
          newStartPageToken: 'P2',
        }),
      };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gdrive', {}), deps);

    expect(cap.errored).toBe(false);
    const event = onlyEvent(cap);
    expect(event.source).toBe('gdrive');
    expect(JSON.stringify(event.payload)).not.toContain('Mila');
    expect(cap.cursor).toEqual({ pageToken: 'P2' });
  });
});

describe('syncConnection — pagination (drain all pages before advancing)', () => {
  it('Calendar drains every page; the terminal nextSyncToken arrives only on the last', async () => {
    const { fetchImpl } = routedFetch([
      // page 2 (matched first): terminal nextSyncToken, no nextPageToken
      { match: 'pageToken=PAGE2', body: { items: [{ id: 'ev2', summary: 'park' }], nextSyncToken: 'SYNC-2' } },
      // page 1: items + nextPageToken, NO nextSyncToken
      {
        match: 'calendar/v3/calendars/primary/events',
        body: { items: [{ id: 'ev1', summary: 'library' }], nextPageToken: 'PAGE2' },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(false);
    // BOTH pages' items emitted — page-2 items are silently lost without pagination.
    expect(cap.enqueued.map((e) => e.payload.id)).toEqual(['ev1', 'ev2']);
    // Cursor advances to the LAST page's sync token, not {syncToken: undefined}.
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-2' });
  });

  it('Calendar: a page with items but NO terminal token errors — cursor untouched, nothing emitted (no double-emit)', async () => {
    const { fetchImpl } = routedFetch([
      { match: 'calendar/v3/calendars/primary/events', body: { items: [{ id: 'ev1' }] } },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(true);
    expect(cap.cursor).toBeUndefined();
    expect(cap.enqueued).toHaveLength(0);
  });

  it('Gmail drains all history pages before advancing historyId (later-page messages are not skipped)', async () => {
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('/messages/m1')) {
        return { ok: true, status: 200, json: async () => ({ id: 'm1', snippet: 'a', payload: { headers: [] } }) };
      }
      if (url.includes('/messages/m2')) {
        return { ok: true, status: 200, json: async () => ({ id: 'm2', snippet: 'b', payload: { headers: [] } }) };
      }
      if (url.includes('pageToken=H2')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ history: [{ messagesAdded: [{ message: { id: 'm2' } }] }], historyId: '9200' }),
        };
      }
      // history page 1: m1 + nextPageToken H2 (no terminal historyId advance yet)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          history: [{ messagesAdded: [{ message: { id: 'm1' } }] }],
          nextPageToken: 'H2',
          historyId: '9100',
        }),
      };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gmail', { historyId: '9002' }), deps);

    expect(cap.errored).toBe(false);
    expect(cap.enqueued.map((e) => e.payload.id).sort()).toEqual(['m1', 'm2']);
    // historyId advances to the last page's value, past all drained messages.
    expect(cap.cursor).toEqual({ historyId: '9200' });
  });
});

describe('syncConnection — failure isolation & token refresh', () => {
  it('a failed fetch sets status=error and does NOT advance the cursor (no double-emit / no loss)', async () => {
    const fetchImpl: GoogleFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(true);
    expect(cap.cursor).toBeUndefined(); // cursor untouched
    expect(cap.enqueued).toHaveLength(0);
  });

  it('refreshes an expired access token before fetching, then persists it', async () => {
    const expired: OAuthTokens = { accessToken: 'ya29.old', refreshToken: '1//refresh', expiresAt: Date.now() - 1000 };
    const { fetchImpl, calls } = routedFetch([
      { match: 'calendar/v3', body: { items: [], nextSyncToken: 'S' } },
    ]);
    let refreshCalled = false;
    const { deps, cap } = stubDeps({
      googleFetch: fetchImpl,
      refreshTokens: async () => {
        refreshCalled = true;
        return { accessToken: 'ya29.refreshed' };
      },
    });
    await syncConnection(connection('gcal', {}, expired), deps);

    expect(refreshCalled).toBe(true);
    // The refreshed access token (not the stale one) is what hit Google.
    expect(calls[0]?.token).toBe('ya29.refreshed');
    // The refreshed token is persisted, preserving the original refresh token.
    expect(cap.refreshed?.accessToken).toBe('ya29.refreshed');
    expect(cap.refreshed?.refreshToken).toBe('1//refresh');
  });

  it('does NOT refresh a still-valid token', async () => {
    const { fetchImpl } = routedFetch([{ match: 'calendar/v3', body: { items: [], nextSyncToken: 'S' } }]);
    let refreshCalled = false;
    const { deps } = stubDeps({
      googleFetch: fetchImpl,
      refreshTokens: async () => {
        refreshCalled = true;
        return { accessToken: 'x' };
      },
    });
    await syncConnection(connection('gcal', {}, FRESH), deps);
    expect(refreshCalled).toBe(false);
  });
});
