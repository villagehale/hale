import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The disconnect action's honesty contract. The old fetch-the-route path returned
 * `{status:'revoked'}` regardless of whether a row matched — a co-parent clicking
 * disconnect on a connection that wasn't theirs saw success while nothing was
 * revoked. This action delegates to revokeFamilyConnector (whose not_found path is
 * real) and must surface every non-revoked result as an error. Its success label says
 * what Google confirmed, one label per outcome, and never claims more.
 */
vi.mock('~/lib/integrations/load', () => ({
  revokeFamilyConnector: vi.fn(),
}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { revalidatePath } from 'next/cache';
import { revokeFamilyConnector } from '~/lib/integrations/load';
import { disconnectConnectorAction } from './connector-actions';

const revokeMock = vi.mocked(revokeFamilyConnector);

function form(provider?: string): FormData {
  const data = new FormData();
  if (provider !== undefined) data.set('provider', provider);
  return data;
}

async function successLabel(google: 'revoked' | 'pending_retry' | 'not_confirmed') {
  revokeMock.mockResolvedValue({ status: 'revoked', google });
  const state = await disconnectConnectorAction({ status: 'idle' }, form('gcal'));
  expect(state.status).toBe('success');
  return state.status === 'success' ? state.message : '';
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('disconnectConnectorAction', () => {
  it('on revoked: succeeds, refreshes the page, and names both services', async () => {
    const message = await successLabel('revoked');
    expect(message).toContain('Gmail');
    expect(message).toContain('Google Calendar');
    expect(revokeMock).toHaveBeenCalledWith('gcal');
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
  });

  /** Hale now revokes at Google, so no label sends the parent to do it by hand. */
  it('never points the parent at Google to remove Hale themselves', async () => {
    const labels = [
      await successLabel('revoked'),
      await successLabel('pending_retry'),
      await successLabel('not_confirmed'),
    ];
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain('myaccount.google.com');
    }
    // Each outcome has its own truthful label: an unconfirmed revoke never reads as a
    // pending one, and neither reads as the confirmed one.
    expect(new Set(labels).size).toBe(3);
  });

  it('on not_found: an error, never a false success (the co-parent no-op bug)', async () => {
    revokeMock.mockResolvedValue({ status: 'not_found' });
    const state = await disconnectConnectorAction({ status: 'idle' }, form('gcal'));
    expect(state.status).toBe('error');
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('on unauthenticated: an error asking to sign in', async () => {
    revokeMock.mockResolvedValue({ status: 'unauthenticated' });
    const state = await disconnectConnectorAction({ status: 'idle' }, form('gcal'));
    expect(state.status).toBe('error');
  });

  it('rejects a missing provider without touching the revoke machinery', async () => {
    const state = await disconnectConnectorAction({ status: 'idle' }, form());
    expect(state.status).toBe('error');
    expect(revokeMock).not.toHaveBeenCalled();
  });
});
