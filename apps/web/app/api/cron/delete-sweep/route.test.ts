import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeletionSweepSummary } from '~/lib/rights/delete';
import { emptyOrphanSweepSummary } from '~/lib/rights/orphan-users';

/**
 * The delete-sweep cron answers with counts and outcome codes only (rule #1): the sweep
 * summary names each Google row by integration id, and the response must not. The sweeps
 * themselves are pinned against pglite in rights/; here they are stubbed at the module
 * boundary so the route's own response shaping is what is tested.
 */

const SECRET = 'cron-secret-delete-sweep';
const INTEGRATION_ID = '7d0a4c1e-3b52-4f8e-9a61-2c5d8e0f1b37';
const runDeletionSweepMock = vi.fn();

vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: vi.fn() }));
vi.mock('~/lib/rights/delete', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/rights/delete')>()),
  runDeletionSweep: (...args: unknown[]) => runDeletionSweepMock(...args),
  sweepMessageRetention: async () => ({ messages: 0 }),
}));
vi.mock('~/lib/rights/record-retention', () => ({
  sweepRecordRetention: async () => ({ removedEpisodesBlanked: 0, proactiveCandidatesDeleted: 0 }),
}));
vi.mock('~/lib/channel/checkin/notes', () => ({ purgeExpiredCheckInNotes: async () => 0 }));
vi.mock('~/lib/channel/linq/roster-retention', () => ({
  sweepRosterRetention: async () => ({ outcome: 'not_migrated' }),
}));
vi.mock('~/lib/channel/linq/secret-santa', () => ({
  sweepSecretSantaRetention: async () => ({ cancelled: 0, deleted: 0 }),
}));
vi.mock('~/lib/signup/browser-use/runner', () => ({ remoteProfileDeleterFromEnv: () => null }));
vi.mock('~/lib/signup/browser-use/vault', () => ({
  sweepExpiredProviderSessions: async () => ({ deleted: 0, remotePending: 0, remoteFailed: 0 }),
}));
vi.mock('~/lib/signup/credentials/store', () => ({
  sweepStaleProviderCredentials: async () => ({ deleted: 0 }),
}));

function summaryWithGoogleRow(): DeletionSweepSummary {
  return {
    erased: 1,
    orphans: emptyOrphanSweepSummary(),
    purgedObjects: 0,
    googleRevokePending: 0,
    googleEndFailed: 0,
    pastGoogleWait: { unconfirmed: 0, endFailed: 0, page: 'nothing_to_page' },
    google: [{ integrationId: INTEGRATION_ID, provider: 'gcal', google: 'revoked' }],
    undecodableIntake: { sessions: 0, page: 'nothing_to_page' },
  };
}

describe('GET /api/cron/delete-sweep — counts only', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    runDeletionSweepMock.mockReset().mockResolvedValue(summaryWithGoogleRow());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('answers with the Google counts line, never an integration id', async () => {
    const { GET } = await import('./route');

    const res = await GET(
      new Request('http://localhost/api/cron/delete-sweep', {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );

    expect(res.status).toBe(200);
    // Positive control: the summary the route was handed does name the row.
    expect(JSON.stringify(await runDeletionSweepMock.mock.results[0]?.value)).toContain(
      INTEGRATION_ID,
    );
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(INTEGRATION_ID);
    expect(body).toMatchObject({
      ok: true,
      erased: 1,
      purgedObjects: 0,
      google: {
        googleRevokePending: 0,
        googleEndFailed: 0,
        pastGoogleWait: { unconfirmed: 0, endFailed: 0, page: 'nothing_to_page' },
        google: { revoked: 1 },
      },
    });
  });
});
