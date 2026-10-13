import { describe, expect, it } from 'vitest';
import { readAutonomyNotice } from './notice-text';

const context = {
  occasion: 'armed' as const,
  actionType: 'send_email',
  language: 'en',
  detail: null,
};

describe('readAutonomyNotice', () => {
  it('keeps a non-empty message', () => {
    expect(readAutonomyNotice({ message: '  hello there  ' }, context)).toEqual({
      message: 'hello there',
    });
  });

  it('names an empty or unparsed tool input', () => {
    expect(readAutonomyNotice({ message: '   ' }, context)).toEqual({ skipped: 'unparsed' });
    expect(readAutonomyNotice({}, context)).toEqual({ skipped: 'unparsed' });
  });

  it('names a time or a link the context did not give', () => {
    expect(readAutonomyNotice({ message: 'see https://example.test/x' }, context)).toEqual({
      skipped: 'invented',
    });
    expect(readAutonomyNotice({ message: 'at 9:30' }, context)).toEqual({ skipped: 'invented' });
  });

  it('names a text longer than one message', () => {
    expect(readAutonomyNotice({ message: 'a'.repeat(641) }, context)).toEqual({
      skipped: 'over_length',
    });
  });
});
