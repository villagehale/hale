import { describe, expect, it } from 'vitest';
import {
  SOURCE_VENUES,
  isRegisteredSourceCode,
  resolveSourceCode,
  sourceCodeFromViaTag,
} from './index';

describe('resolveSourceCode', () => {
  it('resolves registered venues case-insensitively to the registry key', () => {
    expect(resolveSourceCode('earlyon-richmondhill')).toBe('earlyon-richmondhill');
    expect(resolveSourceCode('Earlyon-Richmondhill')).toBe('earlyon-richmondhill');
    expect(resolveSourceCode('library')).toBe('LIBRARY');
  });

  it('rejects an unknown code', () => {
    expect(resolveSourceCode('earlyon-nowhere')).toBeNull();
    expect(isRegisteredSourceCode('spring-campaign')).toBe(false);
  });

  it('never resolves an inherited Object property', () => {
    expect(resolveSourceCode('constructor')).toBeNull();
    expect(resolveSourceCode('toString')).toBeNull();
  });

  it('recognises referral and join tags by shape', () => {
    expect(resolveSourceCode('friend-0123456789ab')).toBe('friend-0123456789ab');
    expect(resolveSourceCode(`JOIN-${'a'.repeat(32)}`)).toBe(`join-${'a'.repeat(32)}`);
    expect(resolveSourceCode('friend-xyz')).toBeNull();
  });

  it('every registry key is a valid URL code shape (case-folded)', () => {
    for (const key of Object.keys(SOURCE_VENUES)) {
      expect(key.toLowerCase()).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe('sourceCodeFromViaTag', () => {
  it('reads the trailing tag', () => {
    expect(sourceCodeFromViaTag("Hey Hale, what's going on? (via ossington)")).toBe('ossington');
  });

  it('reads the tag when the parent typed after it', () => {
    expect(
      sourceCodeFromViaTag("Hey Hale, what's going on? (via ossington) my kids are 4 and 6"),
    ).toBe('ossington');
  });

  it('reads the tag mid-message', () => {
    expect(sourceCodeFromViaTag('Hi (via markham) — we live in M6K')).toBe('markham');
  });

  it('ignores an unknown code and ordinary parentheses', () => {
    expect(sourceCodeFromViaTag('Hi (via atlantis-nowhere)')).toBeNull();
    expect(sourceCodeFromViaTag('we went (via the highway) to the park')).toBeNull();
  });

  it('skips an unknown tag and keeps a later known one', () => {
    expect(sourceCodeFromViaTag('(via home) hi (via markham)')).toBe('markham');
  });
});

describe('launch attribution codes', () => {
  it('resolves attribution-only codes without giving them venue data', () => {
    expect(resolveSourceCode('ads-vaughan')).toBe('ads-vaughan');
    expect(resolveSourceCode('Social-X')).toBe('social-x');
    expect(SOURCE_VENUES['ads-vaughan']).toBeUndefined();
  });
});
