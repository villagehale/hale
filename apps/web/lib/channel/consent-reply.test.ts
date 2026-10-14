import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsentReader, readConsent, toConsentReading } from './consent-reply';

describe('toConsentReading', () => {
  it('keeps a verdict and a target, and drops anything else', () => {
    expect(toConsentReading({ verdict: 'yes', target: 'none' })).toEqual({
      verdict: 'yes',
      target: 'none',
    });
    expect(toConsentReading({ verdict: 'maybe', target: 'none' })).toBeNull();
    expect(toConsentReading({ verdict: 'yes', target: 'both' })).toBeNull();
    expect(toConsentReading({})).toBeNull();
  });
});

describe('createConsentReader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a missing client and does not log the parent text', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const reader = createConsentReader(() => {
      throw new Error('no key');
    });
    const text = 'نعم، أرسل الملاحظة';
    await expect(reader.read({ question: 'founder_welcome', text })).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('client_unavailable');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(text);
  });
});

describe('readConsent', () => {
  it('names a missing reader and does not log the parent text', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = '帮我介绍附近的家庭';
    await expect(readConsent(undefined, { question: 'intro', text })).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('not_configured');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(text);
    logged.mockRestore();
  });
});
