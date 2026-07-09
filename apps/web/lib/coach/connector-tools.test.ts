import { type GuardDeps, invokeTool } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import type { OAuthTokens } from '~/lib/integrations/token-vault';
import { type ConnectorToolDeps, buildConnectorTools } from './connector-tools';

/**
 * The connector read tools (drive_search / calendar_lookup) executed through the
 * REAL guarded invoker with injected Google I/O + token vault — no live Google, no
 * DB. These pin the boundaries that make them safe:
 *   - the exact Google field mask + result/window caps (metadata only — rule #1),
 *   - the not-connected honesty path (a typed result + card, never an error),
 *   - the token-refresh discipline (refresh an expiring token, preserve the stored
 *     refresh_token),
 *   - FAMILY + USER scoping from the SESSION: a forged familyId in the model's tool
 *     args can't change which family's token is read — the tool ignores model input
 *     and uses ctx,
 *   - NO token leak: no returned field (and no streamed card) ever carries a token.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'user-abc';
const NOW = new Date('2026-07-09T12:00:00Z');

// The guarded invoker needs writeAudit; these tools name no child, so no
// child-content hook is required (they read the parent's OWN connector, not a
// child's content).
function auditRecorder() {
  const audits: unknown[] = [];
  const guardDeps: GuardDeps = { writeAudit: async (e) => void audits.push(e) };
  return { audits, guardDeps };
}

function tool(deps: ConnectorToolDeps, name: string) {
  const t = buildConnectorTools({} as never, deps).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/** A ConnectorToolDeps whose getTokens/fetch/refresh are spies the test controls.
 * The `capturedUrls` list records exactly what URL each tool hit Google with, so a
 * test can assert the field mask + caps + window. */
function fakeDeps(
  over: Partial<ConnectorToolDeps> & {
    tokens?: OAuthTokens | null;
    responses?: unknown[];
  } = {},
): {
  deps: ConnectorToolDeps;
  capturedUrls: string[];
  fetchAccessTokens: string[];
  savedTokens: OAuthTokens[];
  refreshCalls: string[];
} {
  const capturedUrls: string[] = [];
  const fetchAccessTokens: string[] = [];
  const savedTokens: OAuthTokens[] = [];
  const refreshCalls: string[] = [];
  const responses = over.responses ?? [{}];
  let call = 0;
  const deps: ConnectorToolDeps = {
    getTokens: over.getTokens ?? (async () => over.tokens ?? null),
    refreshTokens:
      over.refreshTokens ??
      (async (rt) => {
        refreshCalls.push(rt);
        return { accessToken: 'refreshed-access' } as OAuthTokens;
      }),
    saveTokens:
      over.saveTokens ??
      (async (_db, _f, _u, _p, t) => {
        savedTokens.push(t);
      }),
    fetch:
      over.fetch ??
      (async (url, accessToken) => {
        capturedUrls.push(url);
        fetchAccessTokens.push(accessToken);
        const body = responses[Math.min(call++, responses.length - 1)];
        return { ok: true, status: 200, json: async () => body };
      }),
    now: over.now ?? (() => NOW),
  };
  return { deps, capturedUrls, fetchAccessTokens, savedTokens, refreshCalls };
}

const liveToken: OAuthTokens = {
  accessToken: 'access-live',
  refreshToken: 'refresh-tok',
  expiresAt: NOW.getTime() + 3_600_000, // far from expiry
};

describe('drive_search', () => {
  it('asks Google for exactly the metadata field mask + capped page size, names-only (rule #1)', async () => {
    const { deps, capturedUrls } = fakeDeps({
      tokens: liveToken,
      responses: [
        {
          files: [
            {
              id: 'f1',
              name: 'Daycare permission form',
              mimeType: 'application/pdf',
              modifiedTime: '2026-07-01T09:00:00Z',
              webViewLink: 'https://drive.google.com/file/d/f1/view',
            },
          ],
        },
      ],
    });
    const { guardDeps } = auditRecorder();

    const result = (await invokeTool(
      tool(deps, 'drive_search'),
      { query: 'permission' },
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    )) as { status: string; card: { kind: string; files: unknown[] } };

    const url = capturedUrls[0];
    // Field mask: exactly name,mimeType,modifiedTime,webViewLink — nothing else,
    // and NEVER a content-bearing field. `id` is not fetched (data minimization —
    // the mapping never uses it).
    expect(url).toContain('fields=files(name,mimeType,modifiedTime,webViewLink)');
    expect(url).not.toMatch(/fullText|content|body/i);
    // Result cap.
    expect(url).toContain('pageSize=5');
    // The query is passed as a name-contains search, escaped + wrapped.
    expect(url).toContain(encodeURIComponent("name contains 'permission'"));

    expect(result.status).toBe('ok');
    expect(result.card.kind).toBe('drive');
    expect(result.card.files).toEqual([
      {
        name: 'Daycare permission form',
        mimeType: 'application/pdf',
        modifiedTime: '2026-07-01T09:00:00Z',
        webViewLink: 'https://drive.google.com/file/d/f1/view',
      },
    ]);
  });

  it('caps the returned files at 5 even if Google returns more', async () => {
    const files = Array.from({ length: 9 }, (_, i) => ({
      id: `f${i}`,
      name: `file ${i}`,
      mimeType: 'application/pdf',
      modifiedTime: '2026-07-01T09:00:00Z',
      webViewLink: `https://drive.google.com/file/d/f${i}/view`,
    }));
    const { deps } = fakeDeps({ tokens: liveToken, responses: [{ files }] });
    const { guardDeps } = auditRecorder();

    const result = (await invokeTool(
      tool(deps, 'drive_search'),
      { query: 'x' },
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    )) as { card: { files: unknown[] } };

    expect(result.card.files).toHaveLength(5);
  });

  it('returns a typed not_connected result + card when Drive is not connected (never an error)', async () => {
    const { deps, capturedUrls } = fakeDeps({ tokens: null });
    const { guardDeps } = auditRecorder();

    const result = (await invokeTool(
      tool(deps, 'drive_search'),
      { query: 'anything' },
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    )) as { status: string; card: { kind: string; provider: string } };

    expect(result.status).toBe('not_connected');
    expect(result.card).toEqual({ kind: 'not_connected', provider: 'gdrive' });
    // Not connected → Google is never called.
    expect(capturedUrls).toHaveLength(0);
  });
});

describe('calendar_lookup', () => {
  it('requests a 7-day window with the title/time field mask + result cap (rule #1)', async () => {
    const { deps, capturedUrls } = fakeDeps({
      tokens: liveToken,
      responses: [
        {
          items: [
            {
              summary: 'Swim lesson',
              location: 'Rec centre',
              start: { dateTime: '2026-07-11T09:00:00Z' },
              end: { dateTime: '2026-07-11T10:00:00Z' },
            },
          ],
        },
      ],
    });
    const { guardDeps } = auditRecorder();

    const result = (await invokeTool(
      tool(deps, 'calendar_lookup'),
      {},
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    )) as { status: string; card: { kind: string; events: unknown[] } };

    const url = capturedUrls[0];
    expect(url).toContain(`timeMin=${encodeURIComponent(NOW.toISOString())}`);
    const sevenDaysOut = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(url).toContain(`timeMax=${encodeURIComponent(sevenDaysOut)}`);
    expect(url).toContain('maxResults=10');
    expect(url).toContain('singleEvents=true');
    expect(url).toContain('orderBy=startTime');
    // Field mask: summary/location/start/end only — NEVER attendees or description.
    expect(url).toContain('fields=items(summary,location,start(date,dateTime),end(date,dateTime))');
    expect(url).not.toMatch(/attendees|description/i);

    expect(result.status).toBe('ok');
    expect(result.card.kind).toBe('calendar');
    expect(result.card.events).toEqual([
      {
        title: 'Swim lesson',
        start: '2026-07-11T09:00:00Z',
        end: '2026-07-11T10:00:00Z',
        location: 'Rec centre',
      },
    ]);
  });

  it('returns not_connected for calendar when the parent has no gcal connection', async () => {
    const { deps } = fakeDeps({ tokens: null });
    const { guardDeps } = auditRecorder();

    const result = (await invokeTool(
      tool(deps, 'calendar_lookup'),
      {},
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    )) as { status: string; card: { kind: string; provider: string } };

    expect(result.status).toBe('not_connected');
    expect(result.card).toEqual({ kind: 'not_connected', provider: 'gcal' });
  });
});

describe('token refresh discipline', () => {
  it('refreshes an expiring token, preserves the stored refresh_token, and calls Google with the fresh access token', async () => {
    const expiring: OAuthTokens = {
      accessToken: 'access-old',
      refreshToken: 'refresh-tok',
      expiresAt: NOW.getTime() + 10_000, // inside the 60s skew → refresh
    };
    const { deps, fetchAccessTokens, savedTokens, refreshCalls } = fakeDeps({
      tokens: expiring,
      responses: [{ files: [] }],
    });
    const { guardDeps } = auditRecorder();

    await invokeTool(
      tool(deps, 'drive_search'),
      { query: 'x' },
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    );

    expect(refreshCalls).toEqual(['refresh-tok']);
    // Google is called with the refreshed access token, not the stale one.
    expect(fetchAccessTokens).toEqual(['refreshed-access']);
    // The persisted token keeps the original refresh_token (Google omits it on refresh).
    expect(savedTokens).toHaveLength(1);
    expect(savedTokens[0]?.refreshToken).toBe('refresh-tok');
  });

  it('does NOT refresh a still-valid token', async () => {
    const { deps, fetchAccessTokens, refreshCalls } = fakeDeps({
      tokens: liveToken,
      responses: [{ files: [] }],
    });
    const { guardDeps } = auditRecorder();

    await invokeTool(
      tool(deps, 'drive_search'),
      { query: 'x' },
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    );

    expect(refreshCalls).toEqual([]);
    expect(fetchAccessTokens).toEqual(['access-live']);
  });
});

describe('family + user scoping is taken from the SESSION, never model input', () => {
  it('ignores a forged familyId/userId in the tool args and reads the ctx family+actor token', async () => {
    const getTokens: ConnectorToolDeps['getTokens'] = vi.fn(async () => liveToken);
    const { deps } = fakeDeps({ getTokens, responses: [{ files: [] }] });
    const { guardDeps } = auditRecorder();

    // A hallucinated/forged scope the model might try to smuggle in the args.
    await invokeTool(
      tool(deps, 'drive_search'),
      { query: 'x', familyId: 'ATTACKER-FAMILY', userId: 'ATTACKER-USER' } as never,
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    );

    // The token lookup used the SESSION (ctx) family + actor — the forged args were
    // never passed through.
    expect(getTokens).toHaveBeenCalledTimes(1);
    expect(getTokens).toHaveBeenCalledWith(expect.anything(), FAMILY_ID, ACTOR, 'gdrive');
    expect(getTokens).not.toHaveBeenCalledWith(
      expect.anything(),
      'ATTACKER-FAMILY',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('no token ever leaves the tool (rule #1)', () => {
  it('serialised drive + calendar results carry no access/refresh token', async () => {
    const driveDeps = fakeDeps({
      tokens: liveToken,
      responses: [
        {
          files: [
            {
              id: 'f1',
              name: 'notes',
              mimeType: 'application/pdf',
              modifiedTime: '2026-07-01T09:00:00Z',
              webViewLink: 'https://drive.google.com/file/d/f1/view',
            },
          ],
        },
      ],
    });
    const { guardDeps } = auditRecorder();
    const driveResult = await invokeTool(
      tool(driveDeps.deps, 'drive_search'),
      { query: 'x' },
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    );

    const calDeps = fakeDeps({
      tokens: liveToken,
      responses: [
        { items: [{ summary: 'e', start: { dateTime: '2026-07-11T09:00:00Z' }, end: { dateTime: '2026-07-11T10:00:00Z' } }] },
      ],
    });
    const calResult = await invokeTool(
      tool(calDeps.deps, 'calendar_lookup'),
      {},
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    );

    const blob = JSON.stringify(driveResult) + JSON.stringify(calResult);
    expect(blob).not.toContain('access-live');
    expect(blob).not.toContain('refresh-tok');
    expect(blob.toLowerCase()).not.toContain('accesstoken');
    expect(blob.toLowerCase()).not.toContain('refreshtoken');
  });
});

describe('calendar_lookup — server-side result cap (not just the URL param)', () => {
  it('caps the card at 10 events even when Google returns more', async () => {
    // The maxResults URL param is advisory; the slice backstop is the guarantee.
    const items = Array.from({ length: 11 }, (_, i) => ({
      summary: `Event ${i}`,
      start: { dateTime: `2026-07-1${(i % 9) + 1}T09:00:00Z` },
      end: { dateTime: `2026-07-1${(i % 9) + 1}T10:00:00Z` },
    }));
    const { deps } = fakeDeps({ tokens: liveToken, responses: [{ items }] });
    const { guardDeps } = auditRecorder();
    const result = (await invokeTool(
      tool(deps, 'calendar_lookup'),
      {},
      { familyId: FAMILY_ID, actor: ACTOR },
      guardDeps,
    )) as { status: string; card: { events: unknown[] } };
    expect(result.status).toBe('ok');
    expect(result.card.events).toHaveLength(10);
  });
});
