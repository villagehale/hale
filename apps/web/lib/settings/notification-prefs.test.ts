import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasOptedOut, recordOptIn, recordOptOut } from '~/lib/cron/email-compliance';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { loadNotificationPrefs, setNotificationPrefAction } from './notification-prefs.js';

// The notification-prefs lib resolves the caller's family from the session (never a
// fabricated id — rule #1) and toggles the daily-brief opt-out via the CASL
// email-compliance helpers, writing an audit row on a real change (rule #6). We
// stub those edges so each test exercises the lib's own decision logic (the auth
// boundaries, the no-op short-circuit, the audit payload), not real infra.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDbHandle }));
vi.mock('~/lib/family', async () => {
  const actual = await vi.importActual<typeof import('~/lib/family')>('~/lib/family');
  return { ...actual, resolveFamilyForUser: vi.fn(), ensureUserRow: vi.fn() };
});
vi.mock('~/lib/cron/email-compliance', () => ({
  hasOptedOut: vi.fn(),
  recordOptIn: vi.fn(),
  recordOptOut: vi.fn(),
}));

const GOOGLE_ID = 'google_user_abc';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';

const auditInserts: Array<{ table: unknown; values: unknown }> = [];
const tx = {
  insert: vi.fn((table: unknown) => ({
    values: vi.fn((values: unknown) => {
      auditInserts.push({ table, values });
      return Promise.resolve();
    }),
  })),
};
const fakeDbHandle = {
  transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

describe('notification-prefs', () => {
  beforeEach(() => {
    auditInserts.length = 0;
    authMock.mockReset();
    tx.insert.mockClear();
    fakeDbHandle.transaction.mockClear();
    vi.mocked(resolveFamilyForUser).mockReset().mockResolvedValue(FAMILY_ID);
    vi.mocked(ensureUserRow).mockReset().mockResolvedValue(USER_ID);
    vi.mocked(hasOptedOut).mockReset();
    vi.mocked(recordOptIn).mockReset().mockResolvedValue(undefined);
    vi.mocked(recordOptOut).mockReset().mockResolvedValue(undefined);
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    configureAuth(true);
    authMock.mockResolvedValue({ user: { id: GOOGLE_ID, email: 'ada@hale.test' } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads dailyBriefEmail=true when there is no opt-out on file', async () => {
    vi.mocked(hasOptedOut).mockResolvedValue(false);

    const result = await loadNotificationPrefs();

    expect(result).toEqual({ status: 'ready', prefs: { dailyBriefEmail: true } });
  });

  it('returns preview (writes nothing) when auth is unconfigured', async () => {
    configureAuth(false);

    const result = await setNotificationPrefAction('dailyBriefEmail', false);

    expect(result).toEqual({ status: 'preview' });
    expect(recordOptOut).not.toHaveBeenCalled();
  });

  it('returns not_found for a signed-in parent whose family does not resolve', async () => {
    vi.mocked(resolveFamilyForUser).mockResolvedValue(null);

    const result = await setNotificationPrefAction('dailyBriefEmail', false);

    expect(result).toEqual({ status: 'not_found' });
    expect(recordOptOut).not.toHaveBeenCalled();
  });

  it('turning OFF records an opt-out and writes an audit row (rule #6)', async () => {
    vi.mocked(hasOptedOut).mockResolvedValue(false); // currently subscribed

    const result = await setNotificationPrefAction('dailyBriefEmail', false);

    expect(result).toEqual({ status: 'updated' });
    expect(recordOptOut).toHaveBeenCalledWith(tx, USER_ID, 'daily_digest');
    expect(recordOptIn).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]?.table).toBe(schema.auditLog);
    expect(auditInserts[0]?.values).toMatchObject({
      familyId: FAMILY_ID,
      actor: USER_ID,
      actionTaken: 'notification_pref_updated',
      before: { dailyBriefEmail: true },
      after: { dailyBriefEmail: false },
    });
  });

  it('turning ON records an opt-in when currently opted out', async () => {
    vi.mocked(hasOptedOut).mockResolvedValue(true); // currently opted out

    const result = await setNotificationPrefAction('dailyBriefEmail', true);

    expect(result).toEqual({ status: 'updated' });
    expect(recordOptIn).toHaveBeenCalledWith(tx, USER_ID, 'daily_digest');
    expect(recordOptOut).not.toHaveBeenCalled();
  });

  it('no-ops (no write, no audit) when the pref already matches the target', async () => {
    vi.mocked(hasOptedOut).mockResolvedValue(false); // already subscribed

    const result = await setNotificationPrefAction('dailyBriefEmail', true);

    expect(result).toEqual({ status: 'updated' });
    expect(fakeDbHandle.transaction).not.toHaveBeenCalled();
    expect(recordOptIn).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(0);
  });
});
