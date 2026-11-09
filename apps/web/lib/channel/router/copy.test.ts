import { describe, expect, it } from 'vitest';
import * as copy from './copy';

/** VIL-504 · absolute-zero fixed parent copy: the router ships no fixed lines. */
describe('router copy', () => {
  it('exports no fixed parent-facing sentence', () => {
    for (const name of [
      'failureReply',
      'conflictReply',
      'approvedReceipt',
      'declinedReceipt',
      'UNDONE_RECEIPT',
      'NAME_CAPTURED_REPLY',
      'nothingPendingReply',
      'nothingToUndoReply',
      'outOfRangeReply',
      'whichOneReply',
      'clarifyWhichQuestion',
      'healthDoneReply',
    ]) {
      expect(copy).not.toHaveProperty(name);
    }
    expect(copy.capabilityReply()).toBe('');
  });
});
