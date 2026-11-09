import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConnectorSweepLegs, runConnectorSweepLegs } from './connector-sync-legs';

/**
 * The connector-sync cron's legs (VIL-156 follow-up). The Google revoke legs hold the
 * only copy of a live token Hale keeps just to revoke it, so they run FIRST, and no
 * other leg's throw or spent time can starve them. Every leg's outcome is named.
 */

function recordingLegs(throwing: ReadonlySet<keyof ConnectorSweepLegs> = new Set()) {
  const ran: string[] = [];
  const leg =
    <T>(name: keyof ConnectorSweepLegs, value: T) =>
    async () => {
      ran.push(name);
      if (throwing.has(name)) throw new Error(`${name} broke`);
      return value;
    };
  const legs: ConnectorSweepLegs = {
    googleRevokeExpiry: leg('googleRevokeExpiry', { abandoned: 2 }),
    googleRevokeRetry: leg('googleRevokeRetry', { attempted: 1 }),
    sync: leg('sync', { synced: 3 }),
    pushRenewal: leg('pushRenewal', { opened: 1 }),
  };
  return { legs, ran };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runConnectorSweepLegs', () => {
  it('runs the two revoke legs before the poll sync and the push renewal', async () => {
    const { legs, ran } = recordingLegs();
    await runConnectorSweepLegs(legs);
    expect(ran).toEqual(['googleRevokeExpiry', 'googleRevokeRetry', 'sync', 'pushRenewal']);
  });

  it('a throwing sync and a throwing renewal starve nothing, and each failure is named', async () => {
    const { legs, ran } = recordingLegs(new Set(['sync', 'pushRenewal']));

    const result = await runConnectorSweepLegs(legs);

    expect(ran).toEqual(['googleRevokeExpiry', 'googleRevokeRetry', 'sync', 'pushRenewal']);
    expect(result).toEqual({
      ok: false,
      googleRevokeExpiry: { status: 'ok', abandoned: 2 },
      googleRevokeRetry: { status: 'ok', attempted: 1 },
      sync: { status: 'failed', error: 'Error' },
      pushRenewal: { status: 'failed', error: 'Error' },
    });
  });

  it('a throwing revoke retry does not stop the sync, and names itself', async () => {
    const { legs, ran } = recordingLegs(new Set(['googleRevokeRetry']));

    const result = await runConnectorSweepLegs(legs);

    expect(ran).toEqual(['googleRevokeExpiry', 'googleRevokeRetry', 'sync', 'pushRenewal']);
    expect(result.googleRevokeRetry).toEqual({ status: 'failed', error: 'Error' });
    expect(result.sync).toEqual({ status: 'ok', synced: 3 });
  });

  it('positive control: every leg ok reads ok', async () => {
    const { legs } = recordingLegs();
    expect(await runConnectorSweepLegs(legs)).toEqual({
      ok: true,
      googleRevokeExpiry: { status: 'ok', abandoned: 2 },
      googleRevokeRetry: { status: 'ok', attempted: 1 },
      sync: { status: 'ok', synced: 3 },
      pushRenewal: { status: 'ok', opened: 1 },
    });
  });
});
