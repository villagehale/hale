import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_CHIP_TONES,
  ATTACHMENTS_ENABLED,
  attachmentChipTone,
  formatAttachmentSize,
} from './attachment-ui';

/**
 * The composer's pure attachment-display seams. Sizes and the tint cycle come from
 * the design handoff rules, not from output. The gate is ON now that the B4 backend
 * (POST /api/coach/attachments + the attachmentIds param) is on main.
 */
describe('formatAttachmentSize', () => {
  it('renders one-decimal MB at or above 1,000,000 bytes', () => {
    expect(formatAttachmentSize(1_000_000)).toBe('1.0 MB');
    expect(formatAttachmentSize(2_450_000)).toBe('2.5 MB');
  });

  it('renders rounded KB below 1,000,000 bytes', () => {
    expect(formatAttachmentSize(999_999)).toBe('977 KB');
    expect(formatAttachmentSize(2048)).toBe('2 KB');
  });

  it('floors a tiny file to at least 1 KB', () => {
    expect(formatAttachmentSize(10)).toBe('1 KB');
    expect(formatAttachmentSize(0)).toBe('1 KB');
  });
});

describe('attachmentChipTone', () => {
  it('cycles the four tones in order', () => {
    expect([0, 1, 2, 3].map(attachmentChipTone)).toEqual(['berry', 'apricot', 'sage', 'amber']);
  });

  it('wraps back to the first tone past the palette length', () => {
    expect(attachmentChipTone(4)).toBe('berry');
    expect(attachmentChipTone(5)).toBe('apricot');
  });

  it('has exactly the four handoff tones', () => {
    expect(ATTACHMENT_CHIP_TONES).toEqual(['berry', 'apricot', 'sage', 'amber']);
  });
});

describe('ATTACHMENTS_ENABLED', () => {
  it('is on now that the B4 backend (POST /api/coach/attachments + attachmentIds) is on main', () => {
    expect(ATTACHMENTS_ENABLED).toBe(true);
  });
});
