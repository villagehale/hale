import { describe, expect, it } from 'vitest';
import {
  CLAIM_READER_ENFORCE_ALLOWLIST_ENV,
  CLAIM_READER_MODE_ENV,
  claimReaderEnforces,
  claimReaderMode,
} from './flag';

describe('CLAIM_READER_MODE', () => {
  it('enforces by default; off (trimmed) is the kill switch', () => {
    expect(CLAIM_READER_MODE_ENV).toBe('CLAIM_READER_MODE');
    expect(claimReaderMode({})).toBe('enforce');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'shadow' })).toBe('shadow');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'enforce' })).toBe('enforce');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'off' })).toBe('off');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'off\n' })).toBe('off');
    expect(claimReaderMode({ CLAIM_READER_MODE: ' off ' })).toBe('off');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'false' })).toBe('off');
    // Anything else is not a kill: the default stands.
    expect(claimReaderMode({ CLAIM_READER_MODE: 'OFF' })).toBe('enforce');
    expect(claimReaderMode({ CLAIM_READER_MODE: 'shadow\n' })).toBe('enforce');
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

  it('every family is enforced with nothing set; a listed family is not enforced while off', () => {
    expect(claimReaderEnforces(OTHER, allow(undefined, undefined))).toBe(true);
    expect(claimReaderEnforces(FAMILY, allow('off', FAMILY))).toBe(false);
    expect(claimReaderEnforces(FAMILY, allow('off\n', FAMILY))).toBe(false);
  });
});
