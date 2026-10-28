import { describe, expect, it } from 'vitest';
import { pageSource } from './page-source';

describe('pageSource', () => {
  it('reads ?s= first, then the poster QR ?src=', async () => {
    expect(await pageSource(Promise.resolve({ s: 'ossington', src: 'poster-kensington' }))).toBe(
      'ossington',
    );
    expect(await pageSource(Promise.resolve({ src: 'poster-kensington' }))).toBe(
      'poster-kensington',
    );
  });
  it('falls back to utm_campaign on poster links only', async () => {
    expect(
      await pageSource(
        Promise.resolve({ utm_source: 'poster', utm_campaign: 'poster-grange-park' }),
      ),
    ).toBe('poster-grange-park');
    expect(
      await pageSource(Promise.resolve({ utm_source: 'google', utm_campaign: 'spring' })),
    ).toBeNull();
  });
  it('drops anything that is not a code', async () => {
    expect(await pageSource(Promise.resolve({ src: 'Maya Smith' }))).toBeNull();
    expect(await pageSource()).toBeNull();
  });
  it('drops a well-shaped code the intake would not keep, and says so', async () => {
    expect(await pageSource(Promise.resolve({ s: 'spring-campaign' }))).toBeNull();
    expect(await pageSource(Promise.resolve({ src: 'poster-nowhere' }))).toBeNull();
  });
  it('accepts src= and a poster utm_campaign when ?s= is unregistered', async () => {
    expect(await pageSource(Promise.resolve({ s: 'nope-code', src: 'poster-kensington' }))).toBe(
      'poster-kensington',
    );
  });
});
