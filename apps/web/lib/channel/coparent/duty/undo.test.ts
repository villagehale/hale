import { describe, expect, it } from 'vitest';
import { readDutyUndo } from './undo';

describe('readDutyUndo', () => {
  it('still clears the phrases it already treated as undo', () => {
    for (const text of ['undo', 'nvm', 'nm', 'never mind', 'nevermind', 'scratch that.']) {
      expect(readDutyUndo(text)).toEqual({ kind: 'clear' });
    }
  });

  it('does not treat a question or a cancel of some other ask as a duty clear', () => {
    expect(readDutyUndo('undo?')).toBeNull();
    expect(readDutyUndo('cancel')).toBeNull();
  });
});
