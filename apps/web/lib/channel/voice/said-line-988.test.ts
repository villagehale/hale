import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CrisisKind,
  crisisReplyAcceptable,
  crisisTextHas988,
  deliverCrisisReply,
} from './said-line';

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
    expect(crisisReplyAcceptable('mental', 'Salle 4-988-12.')).toBe(false);
    expect(crisisReplyAcceptable('mental', 'Room 49881.')).toBe(false);
    expect(crisisReplyAcceptable('mental', 'Call 1988.')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Ref 1-911-2.')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Ref 19112.')).toBe(false);
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
    expect(crisisReplyAcceptable('mental', 'Ref 4 988 12.')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Call 911.555.0100.')).toBe(false);
  });

  it('a space or slash that runs on into more digits makes a longer number too', () => {
    expect(crisisReplyAcceptable('mental', 'Call 988 555 0100')).toBe(false);
    expect(crisisReplyAcceptable('mental', '988/555/0100')).toBe(false);
    expect(crisisReplyAcceptable('emergency', '911 555 0100')).toBe(false);
  });

  it.each([
    ['988 then 24/7', 'mental', '988 24/7'],
    ['French 24 h', 'mental', 'Appelle le 988 24 h sur 24'],
    ['Chinese comma then 24小时', 'mental', '拨打988，24小时'],
    ['Chinese 全天', 'mental', '拨打988 全天'],
    ['24 hours', 'mental', 'Call or text 988 24 hours a day'],
    ['24 heures', 'mental', 'Le 988, 24 heures sur 24'],
    ['24 horas', 'mental', 'Llama al 988 24 horas'],
    ['24h', 'emergency', 'Appelle le 911 24h sur 24'],
  ] as const)('%s: only listed hours text may follow the number', (_name, kind, text) => {
    expect(crisisReplyAcceptable(kind, text)).toBe(true);
  });
});

describe('native-script digits', () => {
  it.each([
    ['Arabic-Indic', 'mental', 'اتصل على ٩٨٨'],
    ['Extended Arabic-Indic', 'mental', 'تماس با ۹۸۸'],
    ['Devanagari', 'mental', 'कृपया ९८८ पर कॉल करें'],
    ['Arabic-Indic 911', 'emergency', 'اتصل بـ ٩١١ الآن'],
  ] as const)('%s digits read as the line', (_name, kind, text) => {
    expect(crisisReplyAcceptable(kind, text)).toBe(true);
  });

  it('an emergency reply with Arabic-Indic 988 still leaks the 988 line', () => {
    expect(crisisTextHas988('٩٨٨')).toBe(true);
    expect(crisisReplyAcceptable('emergency', 'اتصل بـ ٩١١ أو ٩٨٨')).toBe(false);
    expect(crisisReplyAcceptable('mental', 'اتصل بـ ٩١١')).toBe(false);
  });
});

describe('separators before listed hours or the other crisis line', () => {
  it.each([
    ['en dash then hours', 'mental', 'Call or text 988 – 24/7, free and confidential.'],
    ['hyphen then hours', 'mental', 'Call or text 988 - 24/7.'],
    ['em dash then French hours', 'mental', 'Appelle le 9-8-8 — 24 heures sur 24.'],
    ['emergency, hyphen then hours', 'emergency', 'Call 911 - 24/7.'],
    ['French 24 h/24', 'mental', 'Appelle le 988 24 h/24.'],
    ['988, a full stop, then 911', 'mental', 'Call or text 988. 911 if you are in danger.'],
    ['988 slash 911', 'mental', 'Call 988 / 911 if in danger.'],
    ['911 slash 988', 'mental', 'Call 911 / 988.'],
    ['hours before the line', 'mental', 'Available 24/7 988'],
  ] as const)('%s: the reply carries the line', (_name, kind, text) => {
    expect(crisisReplyAcceptable(kind, text)).toBe(true);
  });

  it('listed hours or a crisis line that run on into more digits still make a longer number', () => {
    expect(crisisReplyAcceptable('mental', 'Call 988 24h5550100')).toBe(false);
    expect(crisisReplyAcceptable('mental', 'Call 988 24/7555')).toBe(false);
    expect(crisisReplyAcceptable('mental', 'Call 988 / 911 555 0100')).toBe(false);
    expect(crisisReplyAcceptable('mental', 'Ref 5 911 988')).toBe(false);
    expect(crisisReplyAcceptable('emergency', 'Call 911 / 988.')).toBe(false);
  });
});

describe('every decimal digit script folds', () => {
  it('Thai digits read as the line', () => {
    expect(crisisReplyAcceptable('mental', 'โทร ๙๘๘')).toBe(true);
  });

  it('a Bengali run-on is a longer number', () => {
    expect(crisisReplyAcceptable('mental', 'Call 988 ৫৫৫ ০১০০')).toBe(false);
  });
});

// Hand-written expectations: a reader reply is sent only when every number in it is a
// crisis line or a listed hours form. Each row goes through deliverCrisisReply, the
// seam a parent's crisis reply actually passes. Digit runs are fictional (555-01xx).
describe('evasion table: the reader reply carries the crisis line and nothing longer', () => {
  afterEach(() => vi.restoreAllMocks());

  async function readerTextSent(kind: CrisisKind, readerText: string): Promise<boolean> {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.fn(async () => null);
    const body = await deliverCrisisReply({
      kind,
      readerText,
      parentWords: 'parent words',
      where: 'evasion table',
      region: null,
      writer: { write },
    });
    expect(write).toHaveBeenCalledTimes(body === null ? 1 : 0);
    return body === readerText;
  }

  it.each([
    ['mental', '988 555 0100'],
    ['mental', '988/555/0100'],
    ['mental', '988,555,0100'],
    ['mental', '988:555:0100'],
    ['mental', "988'555'0100"],
    ['mental', '(988) 555-0100'],
    ['mental', '+1 988 555 0100'],
    ['emergency', '911 555 0100'],
    ['mental', '988 24/75'],
    ['emergency', '911 24/7-555-0100'],
    ['mental', '1988'],
    ['mental', 'Room 49881'],
    ['mental', '988x5550100'],
    ['mental', 'Call 988~555~0100'],
    ['mental', 'Call or text 988.\n555 0100'],
  ] as const)('%s %j is not sent', async (kind, text) => {
    expect(await readerTextSent(kind, text)).toBe(false);
  });

  it.each([
    ['mental', '988 24/7'],
    ['mental', 'Appelle le 988 24 h sur 24'],
    ['mental', '拨打988，24小时'],
    ['mental', '٩٨٨'],
    ['mental', '988. 911 if you are in danger'],
    ['mental', '988 / 911'],
    ['mental', 'Call or text 988.'],
    ['mental', 'Appelle ou texte le 9-8-8, 24 h/24.'],
    ['emergency', 'Appelle le 9-1-1 maintenant.'],
  ] as const)('%s %j is sent', async (kind, text) => {
    expect(await readerTextSent(kind, text)).toBe(true);
  });
});
