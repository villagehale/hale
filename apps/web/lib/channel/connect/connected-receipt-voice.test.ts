import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectedReceiptBody } from './connected-notice';

describe('connected receipt voice', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends the model receipt, and nothing canned when the model is missing', async () => {
    const composed = await connectedReceiptBody('en', 'gmail', {
      async compose() {
        return { reply: 'Gmail is connected.' };
      },
    });
    expect(composed).toBe('Gmail is connected.');
    expect(composed).not.toMatch(/\bSTOP\b|\?/);

    const missing = await connectedReceiptBody('en', 'gcal', undefined);
    expect(missing).toBe('');
  });

  it('does not send a receipt that names the other connector', async () => {
    const body = await connectedReceiptBody('fr', 'gcal', {
      async compose() {
        return { reply: 'Ton Gmail est connecté.' };
      },
    });
    expect(body).toBe('');
    expect(body).not.toMatch(/Gmail|calendrier/i);
  });
});
