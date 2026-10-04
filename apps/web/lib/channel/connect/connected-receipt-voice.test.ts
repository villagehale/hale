import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectedReceiptBody } from './connected-notice';
import { CONNECTOR_CONNECTED_TEXT } from './text-connect';

describe('connected receipt voice', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the locked sentence when friend voice is off', async () => {
    await expect(connectedReceiptBody('en', 'gcal', undefined)).resolves.toBe(
      CONNECTOR_CONNECTED_TEXT.gcal,
    );
    await expect(connectedReceiptBody('en', 'gmail', undefined)).resolves.toBe(
      CONNECTOR_CONNECTED_TEXT.gmail,
    );
  });

  it('sends the model receipt, and nothing canned when the model is missing', async () => {
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
    const composed = await connectedReceiptBody('en', 'gmail', {
      async compose() {
        return { reply: 'Gmail is connected.' };
      },
    });
    expect(composed).toBe('Gmail is connected.');
    expect(composed).not.toMatch(/\bSTOP\b|\?/);

    const missing = await connectedReceiptBody('en', 'gcal', undefined);
    expect(missing).toBe('');
    expect(missing).not.toBe(CONNECTOR_CONNECTED_TEXT.gcal);
  });

  it('does not send a receipt that names the other connector', async () => {
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
    const body = await connectedReceiptBody('fr', 'gcal', {
      async compose() {
        return { reply: 'Ton Gmail est connecté.' };
      },
    });
    expect(body).toBe('');
    expect(body).not.toMatch(/Gmail|calendrier/i);
  });
});
