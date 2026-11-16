import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_STORAGE_KEY,
  attributionCookie,
  readFirstTouchAttribution,
} from './attribution.js';

describe('readFirstTouchAttribution', () => {
  it('remembers the first utm_source and fills a later gclid', () => {
    const storage = new Map<string, string>();
    const session = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };
    const first = readFirstTouchAttribution(
      '?utm_source=poster&utm_medium=qr&utm_content=board',
      session,
    );
    expect(first).toEqual({
      utm_source: 'poster',
      utm_medium: 'qr',
      utm_content: 'board',
    });
    const later = readFirstTouchAttribution('?utm_source=google&gclid=Click1', session);
    expect(later).toEqual({
      utm_source: 'poster',
      utm_medium: 'qr',
      utm_content: 'board',
      gclid: 'Click1',
    });
    expect(storage.get(ATTRIBUTION_STORAGE_KEY)).toContain('gclid=Click1');
  });
});

describe('attributionCookie', () => {
  it('sets Domain=.villagehale.com so checkout on the app subdomain can read it', () => {
    const cookie = attributionCookie({ utm_source: 'google', gclid: 'X' }, 'www.villagehale.com');
    expect(cookie).toContain('hale_attr=');
    expect(cookie).toContain('Domain=.villagehale.com');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('returns null when there is nothing to persist', () => {
    expect(attributionCookie({}, 'www.villagehale.com')).toBeNull();
  });
});
