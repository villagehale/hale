import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The disconnect action's honesty contract. The old fetch-the-route path returned
 * `{status:'revoked'}` regardless of whether a row matched — a co-parent clicking
 * disconnect on a connection that wasn't theirs saw success while nothing was
 * revoked. This action delegates to revokeFamilyConnector (whose not_found path is
 * real) and must surface every non-revoked result as an error — and its success
 * copy must own the local-only truth: Google's own record of the grant survives.
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('disconnectConnectorAction', () => {
  it('on revoked: succeeds, refreshes the page, and states the Google-side truth', async () => {
    revokeMock.mockResolvedValue({ status: 'revoked' });
    const state = await disconnectConnectorAction({ status: 'idle' }, form('gcal'));
    expect(state.status).toBe('success');
    expect(state).toMatchObject({ message: expect.stringContaining('Google') });
    expect(revokeMock).toHaveBeenCalledWith('gcal');
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
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
