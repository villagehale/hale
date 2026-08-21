import { describe, expect, it } from 'vitest';
import { SOURCE_CODE_STORAGE_KEY, type SessionLike, readFirstTouchSourceCode } from './source-code';

/**
 * Expected values are derived from the attribution rule, not from the implementation:
 * the code that EARNED the visit is the one the eventual text is credited to, and
 * nothing that fails the venue-code shape may become an analytics property (rule #1).
 */

function fakeStorage(initial: Record<string, string> = {}): SessionLike & {
  readonly store: Record<string, string>;
} {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

describe('readFirstTouchSourceCode', () => {
  it('reads the tag off the landing URL and remembers it for the session', () => {
    const storage = fakeStorage();
    expect(readFirstTouchSourceCode('?s=earlyon-richmondhill', storage)).toBe(
      'earlyon-richmondhill',
    );
    expect(storage.store[SOURCE_CODE_STORAGE_KEY]).toBe('earlyon-richmondhill');
  });

  it('credits the card that earned the visit, not the page the CTA was tapped on', () => {
    // The parent lands tagged, then browses to an untagged page and texts from there.
    const storage = fakeStorage();
    readFirstTouchSourceCode('?s=swim-loyalfitness', storage);
    expect(readFirstTouchSourceCode('', storage)).toBe('swim-loyalfitness');
  });

  it('does not let a later tag overwrite the first touch', () => {
    const storage = fakeStorage({ [SOURCE_CODE_STORAGE_KEY]: 'earlyon-richmondhill' });
    expect(readFirstTouchSourceCode('?s=daycare-brightpath-milton', storage)).toBe(
      'earlyon-richmondhill',
    );
    expect(storage.store[SOURCE_CODE_STORAGE_KEY]).toBe('earlyon-richmondhill');
  });

  it('is null on an untagged visit with nothing remembered', () => {
    expect(readFirstTouchSourceCode('?utm_campaign=spring', fakeStorage())).toBeNull();
  });

  it('drops a tag that is not a venue code, and never stores it', () => {
    const storage = fakeStorage();
    expect(readFirstTouchSourceCode('?s=sam%40example.com', storage)).toBeNull();
    expect(storage.store[SOURCE_CODE_STORAGE_KEY]).toBeUndefined();
  });

  it('re-validates what it reads back — a poisoned storage key is not attribution', () => {
    const storage = fakeStorage({ [SOURCE_CODE_STORAGE_KEY]: '+1 647 555 1234' });
    expect(readFirstTouchSourceCode('?s=swim-loyalfitness', storage)).toBe('swim-loyalfitness');
  });

  it('still attributes the tagged page when sessionStorage is unavailable', () => {
    // Safari private mode: reading `sessionStorage` throws, so the provider hands null.
    expect(readFirstTouchSourceCode('?s=earlyon-richmondhill', null)).toBe('earlyon-richmondhill');
    expect(readFirstTouchSourceCode('', null)).toBeNull();
  });
});
