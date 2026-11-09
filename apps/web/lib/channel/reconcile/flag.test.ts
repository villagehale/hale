import { describe, expect, it } from 'vitest';
import {
  CLAIM_READER_ENFORCE_ALLOWLIST_ENV,
  CLAIM_READER_MODE_ENV,
  claimReaderEnforces,
  claimReaderMode,
} from './flag';

describe('CLAIM_READER_MODE', () => {
  it('is off unless set to exactly shadow or enforce', () => {
    expect(CLAIM_READER_MODE_ENV).toBe('CLAIM_READER_MODE');
    expect(claimReaderMode({})).toBe('off');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'shadow' })).toBe('shadow');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'enforce' })).toBe('enforce');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'enforce\n' })).toBe('off');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'ENFORCE' })).toBe('off');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'off' })).toBe('off');
  });
});

describe('claimReaderEnforces', () => {
  const FAMILY = 'family-a';
  const OTHER = 'family-b';
  const allow = (mode: string | undefined, list: string | undefined) => ({
    ...(mode !== undefined ? { [CLAIM_READER_MODE_ENV]: mode } : {}),
    ...(list !== undefined ? { [CLAIM_READER_ENFORCE_ALLOWLIST_ENV]: list } : {}),
  });

  it('enforces every family under enforce', () => {
    expect(claimReaderEnforces(FAMILY, allow('enforce', undefined))).toBe(true);
    expect(claimReaderEnforces(OTHER, allow('enforce', ` ${FAMILY} `))).toBe(true);
  });

  it('enforces only the listed families under shadow, trimmed', () => {
    expect(CLAIM_READER_ENFORCE_ALLOWLIST_ENV).toBe('CLAIM_READER_ENFORCE_FAMILY_ALLOWLIST');
    expect(claimReaderEnforces(FAMILY, allow('shadow', ` ${FAMILY} ,${OTHER}x`))).toBe(true);
    expect(claimReaderEnforces(OTHER, allow('shadow', ` ${FAMILY} ,${OTHER}x`))).toBe(false);
    expect(claimReaderEnforces(FAMILY, allow('shadow', undefined))).toBe(false);
  });

  it('a listed family is not enforced while the mode is off', () => {
    expect(claimReaderEnforces(FAMILY, allow(undefined, FAMILY))).toBe(false);
    expect(claimReaderEnforces(FAMILY, allow('enforce\n', FAMILY))).toBe(false);
  });
});
