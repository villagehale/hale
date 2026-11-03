import { describe, expect, it } from 'vitest';
import { CLAIM_READER_MODE_ENV, claimReaderMode } from './flag';

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
