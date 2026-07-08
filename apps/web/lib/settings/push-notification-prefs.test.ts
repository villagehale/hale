import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPushNotificationPrefs, setPushNotificationPref } from './push-notification-prefs';

// The push-notification prefs lib behind the mobile /settings/notifications route:
// resolve the signed-in parent, read the two push booleans (default ON when no
// row), and upsert on change with an audit_log row (rule #6). We stub the auth
// session + family/user resolvers and drive a capturing fake db — no real DB.

const authMock = vi.fn();
const authConfiguredMock = vi.fn();
const resolveFamilyMock = vi.fn();
const ensureUserRowMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => authConfiguredMock() }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  ensureUserRow: (...a: unknown[]) => ensureUserRowMock(...a),
}));

interface Capture {
  upserts: unknown[];
  conflicts: unknown[];
  audit: unknown[];
  /** The stored prefs row loadPushPrefsView reads back (null → both-on default). */
  prefsRow: { pushNewPicks: boolean; pushHealthReminders: boolean } | null;
}
let capture: Capture;

function fakeDb(cap: Capture): unknown {
  const handle = {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.notificationPrefs) {
          return { where: () => ({ limit: async () => (cap.prefsRow ? [cap.prefsRow] : []) }) };
        }
        throw new Error('unexpected select');
      },
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (table === schema.notificationPrefs) {
          cap.upserts.push(values);
          return { onConflictDoUpdate: async (c: unknown) => cap.conflicts.push(c) };
        }
        if (table === schema.auditLog) return Promise.resolve(cap.audit.push(values));
        throw new Error('unexpected insert');
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(handle),
  };
  return handle;
}

vi.mock('~/lib/db', () => ({ db: () => fakeDb(capture) }));

beforeEach(() => {
  capture = { upserts: [], conflicts: [], audit: [], prefsRow: null };
  authMock.mockReset();
  authConfiguredMock.mockReset().mockReturnValue(true);
  resolveFamilyMock.mockReset().mockResolvedValue('fam-1');
  ensureUserRowMock.mockReset().mockResolvedValue('user-1');
  vi.stubEnv('DATABASE_URL', 'postgres://test');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function session(id: string | null) {
  return id ? { user: { id, email: 'p@example.com', name: 'P' } } : null;
}

describe('loadPushNotificationPrefs', () => {
  it('returns the two push booleans for a signed-in parent', async () => {
    authMock.mockResolvedValue(session('google-1'));
    capture.prefsRow = { pushNewPicks: false, pushHealthReminders: true };
    const result = await loadPushNotificationPrefs();

    expect(result).toEqual({
      status: 'ready',
      prefs: { pushNewPicks: false, pushHealthReminders: true },
    });
  });

  it('defaults both streams ON when the parent has no prefs row', async () => {
    authMock.mockResolvedValue(session('google-1'));
    capture.prefsRow = null;
    const result = await loadPushNotificationPrefs();

    expect(result).toEqual({
      status: 'ready',
      prefs: { pushNewPicks: true, pushHealthReminders: true },
    });
  });

  it('is unauthenticated when configured but signed out', async () => {
    authMock.mockResolvedValue(session(null));
    expect((await loadPushNotificationPrefs()).status).toBe('unauthenticated');
  });

  it('is preview when auth is not configured here', async () => {
    authConfiguredMock.mockReturnValue(false);
    expect((await loadPushNotificationPrefs()).status).toBe('preview');
  });
});

describe('setPushNotificationPref', () => {
  it('upserts the changed pref and writes a category-only audit row (rule #6)', async () => {
    authMock.mockResolvedValue(session('google-1'));
    const result = await setPushNotificationPref('pushNewPicks', false);

    expect(result).toEqual({ status: 'updated' });
    // A first toggle upserts the row keyed on the resolved internal user id.
    expect(capture.upserts).toHaveLength(1);
    expect(capture.upserts[0]).toMatchObject({ userId: 'user-1', pushNewPicks: false });
    expect(capture.conflicts[0]).toMatchObject({ target: schema.notificationPrefs.userId });
    // The audit row carries the pref name + values only — no child content.
    expect(capture.audit).toHaveLength(1);
    expect(capture.audit[0]).toMatchObject({
      familyId: 'fam-1',
      actor: 'user-1',
      actionTaken: 'notification_pref_updated',
      after: { pushNewPicks: false },
    });
  });

  it('is not_found for a signed-in parent whose family is unresolved', async () => {
    authMock.mockResolvedValue(session('google-1'));
    resolveFamilyMock.mockResolvedValue(null);
    const result = await setPushNotificationPref('pushHealthReminders', true);

    expect(result.status).toBe('not_found');
    expect(capture.upserts).toEqual([]);
    expect(capture.audit).toEqual([]);
  });
});
