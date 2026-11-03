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

describe('crisisTextHasRequiredNumber through crisisReplyAcceptable', () => {
  it.each([
    ['mental, hyphenated 9-8-8', 'mental', 'Tu peux appeler ou texter le 9-8-8, à toute heure.'],
    ['mental, full-width spaced', 'mental', '请拨打 ９ ８ ８'],
    ['emergency, hyphenated 9-1-1', 'emergency', 'Appelle le 9-1-1 maintenant.'],
    ['mental, plain 988', 'mental', 'Call or text 988.'],
  ] as const)('%s carries the required number', (_name, kind, text) => {
    expect(crisisReplyAcceptable(kind, text)).toBe(true);
  });

  it('still rejects a reply without the required number, or an emergency that leaks 988', () => {
    expect(crisisReplyAcceptable('mental', 'Call 911 now.')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Appelle le 9-1-1, ou le 9-8-8.')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Call 9 1 2.')).toBe(false);
  });

  it('a longer number that contains the digits is not the line', () => {
    expect(crisisReplyAcceptable('mental', 'Appelle le 9-8-8 ou le 911.')).toBe(true);
    expect(crisisReplyAcceptable('mental', 'Appelle le 1-866-988-0000.')).toBe(false);
    expect(crisisReplyAcceptable('mental', 'Call 1988.')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Call 1-800-911-0000.')).toBe(false);
  });

  it.each([
    ['mental, 988 then hours', 'mental', 'Call or text 988 24/7.'],
    ['mental, French hours', 'mental', 'Appelle le 988 24 h sur 24.'],
    ['mental, Chinese hours', 'mental', '请拨打988 24小时'],
    ['mental, 9-8-8 then hours', 'mental', 'Appelle ou texte le 9-8-8 24 h sur 24.'],
    ['emergency, 911 then hours', 'emergency', 'Appelle le 911 24 h sur 24.'],
  ] as const)('%s: a number after a space is not part of the line', (_name, kind, text) => {
    expect(crisisReplyAcceptable(kind, text)).toBe(true);
  });

  it('a hyphen or dot that runs on into more digits still makes a longer number', () => {
    expect(crisisReplyAcceptable('mental', 'Call or text 988 24/7.')).toBe(true);
    expect(crisisReplyAcceptable('mental', 'Call 988-555-0100.')).toBe(false);
    expect(crisisReplyAcceptable('mental', 'Call 1 866 988 0000.')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Call 911.555.0100.')).toBe(false);
  });
});
