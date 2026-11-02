import { describe, expect, it } from 'vitest';
import { crisisReplyAcceptable, crisisTextHas988 } from './said-line';

describe('crisisTextHas988 digit variants', () => {
  it.each([
    ['plain', 'Call or text 988.'],
    ['hyphenated', 'Appelez le 9-8-8.'],
    ['spaced', 'Call 9 8 8 now.'],
    ['dotted', 'Call 9.8.8'],
    ['full-width', '请拨打９８８'],
    ['full-width spaced', '请拨打 ９ ８ ８'],
    ['ideographic space', '９\u3000８\u3000８'],
    ['non-breaking space', '9\u00a08\u00a08'],
    ['en dash', '9\u20138\u20138'],
    ['narrow nbsp', '9\u202f8\u202f8'],
  ])('%s counts as 988', (_name, text) => {
    expect(crisisTextHas988(text)).toBe(true);
  });

  it('does not invent 988 from unrelated digits', () => {
    expect(crisisTextHas988('Call 911.')).toBe(false);
    expect(crisisTextHas988('9 1 1')).toBe(false);
    expect(crisisTextHas988('98 is the bus; 8 kids')).toBe(false);
  });

  it('an emergency reply carrying spaced or full-width 988 is not acceptable', () => {
    expect(crisisReplyAcceptable('emergency', 'Call 911. Or 9 8 8.')).toBe(false);
    expect(crisisReplyAcceptable('emergency', '拨打911或９８８')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Call 911 now.')).toBe(true);
  });
});
