import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES,
  type PendingAttachment,
  attachmentTone,
  buildCoachSendPayload,
  canSendAsk,
  exceedsAttachmentSize,
  formatAttachmentSize,
  readyAttachmentIds,
  uploadErrorMessage,
} from './ask-attachments';

/**
 * The pure logic behind Ask-Hale attachments, mirroring the handoff prototype's
 * `addAttach`/`send` (Feature 4). Expected values are derived from the spec's rules
 * (the ≥1e6-byte MB threshold, the 4-tone cycle, the text-OR-attachment send gate,
 * the server error → friendly-note map), not copied from the code's output.
 */

/** Build a minimal attachment fixture in a given upload state. */
function att(status: PendingAttachment['status'], serverId?: string): PendingAttachment {
  return {
    localId: 'l',
    batchId: 'b',
    name: 'photo.jpg',
    sizeBytes: 1024,
    tone: 'red',
    status,
    file: { uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg' },
    ...(serverId ? { serverId } : {}),
  };
}

describe('formatAttachmentSize', () => {
  it('formats bytes ≥ 1,000,000 as one-decimal MB', () => {
    expect(formatAttachmentSize(1_000_000)).toBe('1.0 MB');
    expect(formatAttachmentSize(1_234_567)).toBe('1.2 MB');
    expect(formatAttachmentSize(10_000_000)).toBe('10.0 MB');
  });

  it('formats just under 1,000,000 bytes as whole KB (the 999KB/1.0MB boundary)', () => {
    // 999_999 / 1024 = 976.56 → 977 KB; the MB threshold is strictly ≥ 1e6.
    expect(formatAttachmentSize(999_999)).toBe('977 KB');
  });

  it('rounds sub-MB byte counts to whole KB', () => {
    expect(formatAttachmentSize(1024)).toBe('1 KB');
    expect(formatAttachmentSize(1536)).toBe('2 KB');
  });

  it('floors tiny/empty files to a minimum of 1 KB', () => {
    expect(formatAttachmentSize(0)).toBe('1 KB');
    expect(formatAttachmentSize(500)).toBe('1 KB');
  });
});

describe('attachmentTone', () => {
  it('cycles red → blue → green → yellow by index', () => {
    expect(attachmentTone(0)).toBe('red');
    expect(attachmentTone(1)).toBe('blue');
    expect(attachmentTone(2)).toBe('green');
    expect(attachmentTone(3)).toBe('yellow');
  });

  it('wraps modulo the four tones', () => {
    expect(attachmentTone(4)).toBe('red');
    expect(attachmentTone(7)).toBe('yellow');
  });
});

describe('exceedsAttachmentSize', () => {
  it('accepts a file exactly at the 10 MiB cap', () => {
    expect(exceedsAttachmentSize(MAX_ATTACHMENT_BYTES)).toBe(false);
  });

  it('rejects a file one byte over the cap', () => {
    expect(exceedsAttachmentSize(MAX_ATTACHMENT_BYTES + 1)).toBe(true);
  });

  it('accepts an empty or ordinarily-sized file', () => {
    expect(exceedsAttachmentSize(0)).toBe(false);
    expect(exceedsAttachmentSize(2_000_000)).toBe(false);
  });

  it('mirrors the server per-file cap (apps/web/lib/coach/attachments.ts)', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('canSendAsk', () => {
  it('enables send with non-empty text and no attachments', () => {
    expect(canSendAsk('hello', [])).toBe(true);
  });

  it('blocks send with empty/whitespace text and no attachments', () => {
    expect(canSendAsk('', [])).toBe(false);
    expect(canSendAsk('   ', [])).toBe(false);
  });

  it('enables an attachments-only send once at least one is ready', () => {
    expect(canSendAsk('', [att('ready', 's1')])).toBe(true);
  });

  it('blocks send while any attachment is still uploading, even with text', () => {
    expect(canSendAsk('', [att('uploading')])).toBe(false);
    expect(canSendAsk('hello', [att('uploading')])).toBe(false);
    expect(canSendAsk('hello', [att('ready', 's1'), att('uploading')])).toBe(false);
  });

  it('does not count an errored attachment as sendable on its own', () => {
    expect(canSendAsk('', [att('error')])).toBe(false);
    expect(canSendAsk('hello', [att('error')])).toBe(true);
  });
});

describe('readyAttachmentIds', () => {
  it('returns only ready server ids, in order', () => {
    const ids = readyAttachmentIds([
      att('ready', 's1'),
      att('uploading'),
      att('error'),
      att('ready', 's2'),
    ]);
    expect(ids).toEqual(['s1', 's2']);
  });

  it('excludes a ready attachment missing its server id', () => {
    expect(readyAttachmentIds([att('ready')])).toEqual([]);
  });
});

describe('buildCoachSendPayload', () => {
  it('includes only question when there is text and no attachments', () => {
    expect(buildCoachSendPayload('hi', [])).toEqual({ question: 'hi' });
  });

  it('trims the question and omits it when whitespace-only', () => {
    expect(buildCoachSendPayload('  hi  ', [])).toEqual({ question: 'hi' });
    expect(buildCoachSendPayload('   ', ['a'])).toEqual({ attachmentIds: ['a'] });
  });

  it('includes only attachmentIds for an attachments-only send', () => {
    expect(buildCoachSendPayload('', ['a', 'b'])).toEqual({ attachmentIds: ['a', 'b'] });
  });

  it('includes both when there is text and attachments', () => {
    expect(buildCoachSendPayload('hi', ['a'])).toEqual({ question: 'hi', attachmentIds: ['a'] });
  });
});

describe('uploadErrorMessage', () => {
  it('maps 415 to the unsupported-type note (not retryable)', () => {
    expect(uploadErrorMessage(415)).toEqual({
      note: "That file type isn't supported yet — JPEG, PNG, WebP or PDF.",
      retryable: false,
    });
  });

  it('maps 413 file_too_large to the 10 MB note (not retryable)', () => {
    expect(uploadErrorMessage(413, 'file_too_large')).toEqual({
      note: 'That file is over 10 MB.',
      retryable: false,
    });
  });

  it('maps 413 too_many_files to the 5-file note (not retryable)', () => {
    expect(uploadErrorMessage(413, 'too_many_files')).toEqual({
      note: 'You can attach up to 5 files.',
      retryable: false,
    });
  });

  it('maps 429 to the rate-limit note (retryable)', () => {
    expect(uploadErrorMessage(429)).toEqual({
      note: 'Too many uploads — try again in a minute.',
      retryable: true,
    });
  });

  it('maps a network/other failure to a retryable note', () => {
    expect(uploadErrorMessage(0).retryable).toBe(true);
    expect(uploadErrorMessage(500).retryable).toBe(true);
  });
});
