import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptConsentAsk,
  createConsentAskWriter,
  instructsConsentKeyword,
  writeConsentAsk,
} from './consent-ask';

describe('instructsConsentKeyword', () => {
  it('rejects a token instruction and allows the carrier opt-out', () => {
    expect(instructsConsentKeyword('Reply YES today')).toBe(true);
    expect(instructsConsentKeyword('Text INTROS back')).toBe(true);
    expect(instructsConsentKeyword('Repondez NON')).toBe(true);
    expect(instructsConsentKeyword('Reply STOP anytime')).toBe(false);
    expect(instructsConsentKeyword('Repondez ARRET')).toBe(false);
    expect(instructsConsentKeyword('Want me to send your note?')).toBe(false);
  });
});

describe('acceptConsentAsk', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a keyword instruction and keeps a long draft in another script', () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const long = `${'Want me to keep this change? '.repeat(20)}`;
    expect(acceptConsentAsk('Reply YES today.')).toBeNull();
    expect(acceptConsentAsk('帮我问问他们')).toBe('帮我问问他们');
    expect(acceptConsentAsk(long)).toBe(long);
    expect(acceptConsentAsk('Want me to send your note?')).toBe('Want me to send your note?');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('over_segment_cap');
  });
});

describe('createConsentAskWriter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a missing client and sends nothing', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const writer = createConsentAskWriter(() => {
      throw new Error('no key');
    });
    await expect(writer.write({ kind: 'founder_retry' })).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('client_unavailable');
  });
});

describe('writeConsentAsk', () => {
  it('names a missing writer', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(
      writeConsentAsk(undefined, { kind: 'founder_ping', location: 'Georgetown' }),
    ).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('not_configured');
    logged.mockRestore();
  });
});
