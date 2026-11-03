import { describe, expect, it } from 'vitest';
import { type CrisisKind, crisisReplyViolation } from './said-line';

// One acceptance check for every crisis reply (design B). Expectations are hand-written
// from the rule: the required line is present, an emergency carries no 988, no other
// number appears, and no link. Digit runs are fictional (555-01xx and similar).

describe('the 988 line in any digit form', () => {
  it.each([
    ['plain', 'Call or text 988.'],
    ['hyphenated', 'Appelez le 9-8-8.'],
    ['spaced', 'Call 9 8 8 now.'],
    ['dotted', 'Call 9.8.8'],
    ['full-width', '请拨打９８８'],
    ['full-width spaced', '请拨打 ９ ８ ８'],
    ['ideographic space', '９　８　８'],
    ['non-breaking space', '9 8 8'],
    ['en dash', '9–8–8'],
    ['narrow nbsp', '9 8 8'],
  ])('%s carries the mental line', (_name, text) => {
    expect(crisisReplyViolation('mental', text)).toBeNull();
  });

  it.each([
    ['spaced', 'Call 911. Or 9 8 8.'],
    ['full-width', '拨打911或９８８'],
    ['comma-spelled after a word', '911, or 9,8,8'],
    ['Arabic-Indic', 'اتصل بـ ٩١١ أو ٩٨٨'],
  ])('an emergency reply with a %s 988 is refused as emergency_988', (_name, text) => {
    expect(crisisReplyViolation('emergency', text)).toBe('emergency_988');
  });

  it('positive control: an emergency reply with 911 alone passes', () => {
    expect(crisisReplyViolation('emergency', 'Call 911 now.')).toBeNull();
    expect(crisisReplyViolation('emergency', 'Appelle le 9-1-1 maintenant.')).toBeNull();
  });

  it('does not invent 988 from unrelated digits', () => {
    expect(crisisReplyViolation('mental', 'Call 911.')).toBe('missing_line');
    expect(crisisReplyViolation('mental', '9 1 1')).toBe('missing_line');
    expect(crisisReplyViolation('emergency', 'Call 911 now. 98 is the bus; 8 kids')).toBe(
      'other_number',
    );
  });
});

describe('the required line', () => {
  it('a reply without it is missing_line', () => {
    expect(crisisReplyViolation('mental', 'I am here with you.')).toBe('missing_line');
    expect(crisisReplyViolation('emergency', 'Call or text 988.')).toBe('missing_line');
    expect(crisisReplyViolation('emergency', 'Call 9 1 2.')).toBe('missing_line');
  });

  it('a longer number that contains the digits is not the line', () => {
    expect(crisisReplyViolation('mental', 'Appelle le 9-8-8 ou le 911.')).toBeNull();
    for (const text of ['Salle 4-988-12.', 'Room 49881.', 'Call 1988.']) {
      expect(crisisReplyViolation('mental', text)).toBe('missing_line');
    }
    expect(crisisReplyViolation('emergency', 'Ref 19112.')).toBe('missing_line');
  });
});

describe('native-script digits', () => {
  it.each([
    ['Arabic-Indic', 'mental', 'اتصل على ٩٨٨'],
    ['Extended Arabic-Indic', 'mental', 'تماس با ۹۸۸'],
    ['Devanagari', 'mental', 'कृपया ९८८ पर कॉल करें'],
    ['Thai', 'mental', 'โทร ๙๘๘'],
    ['Arabic-Indic 911', 'emergency', 'اتصل بـ ٩١١ الآن'],
  ] as const)('%s digits read as the line', (_name, kind, text) => {
    expect(crisisReplyViolation(kind, text)).toBeNull();
  });

  it('a Bengali run-on is a longer number, not the line', () => {
    expect(crisisReplyViolation('mental', 'Call 988 ৫৫৫ ০১০০')).toBe('missing_line');
    expect(crisisReplyViolation('mental', 'Call 988 now, or ৫৫৫ ০১০০')).toBe('other_number');
  });
});

// Every crisis reply, whoever wrote it, goes through this one check. `pass` false
// means that text is never sent.
const EVASION_TABLE: ReadonlyArray<readonly [kind: CrisisKind, text: string, pass: boolean]> = [
  // Round 3 rows; the reader-path column is now the only check.
  ['mental', '988 555 0100', false],
  ['mental', '988/555/0100', false],
  ['mental', '988,555,0100', false],
  ['mental', '988:555:0100', false],
  ['mental', "988'555'0100", false],
  ['mental', '(988) 555-0100', false],
  ['mental', '+1 988 555 0100', false],
  ['emergency', '911 555 0100', false],
  ['mental', '988 24/75', false],
  ['emergency', '911 24/7-555-0100', false],
  ['mental', '1988', false],
  ['mental', 'Room 49881', false],
  ['mental', 'Call 988~555~0100', false],
  ['mental', '988x5550100', false],
  ['mental', 'Call or text 988.\n555 0100', false],
  ['mental', 'Call 988 or room 5550100', false],
  ['mental', 'Call 988-555-0100.', false],
  ['mental', 'Ref 4 988 12.', false],
  ['emergency', 'Call 911.555.0100.', false],
  ['mental', 'Call 988 24h5550100', false],
  ['mental', 'Call 988 24/7555', false],
  ['mental', 'Call 988 / 911 555 0100', false],
  ['mental', 'Ref 5 911 988', false],
  ['emergency', 'Call 911 / 988.', false],
  ['mental', '988 24/7', true],
  ['mental', 'Appelle le 988 24 h sur 24', true],
  ['mental', '拨打988，24小时', true],
  ['mental', '٩٨٨', true],
  ['mental', '988. 911 if you are in danger', true],
  ['mental', '988 / 911', true],
  ['mental', 'Call or text 988.', true],
  ['mental', 'Appelle ou texte le 9-8-8, 24 h/24.', true],
  ['emergency', 'Appelle le 9-1-1 maintenant.', true],
  ['mental', 'Call or text 988 – 24/7, free and confidential.', true],
  ['mental', 'Appelle le 9-8-8 — 24 heures sur 24.', true],
  ['emergency', 'Call 911 - 24/7.', true],
  ['mental', 'Available 24/7 988', true],
  ['mental', 'Call or text 988 24 hours a day', true],
  // Round 4: writer outputs that must not go out.
  ['mental', '741741', false],
  ['mental', 'Text 741741 or call 988.', false],
  ['mental', 'Call or text 988, or see EXAMPLE.COM', false],
  ['mental', 'Call or text 988, or see example。com', false],
  ['mental', 'Call or text 988, or see example[.]com', false],
  ['mental', 'Call or text 988, or see example . com', false],
  // Round 4: hours forms a correct reply uses.
  ['mental', 'Tu peux appeler ou texter le 988, 7 j/7.', true],
  ['mental', 'Tu peux appeler ou texter le 988, 7j/7.', true],
  ['mental', 'Appelle ou texte le 9-8-8, 24 h/24, 7 j/7.', true],
  ['mental', 'Le 988 répond 24 heures sur 24, 7 jours sur 7.', true],
  ['mental', 'اتصل أو أرسل رسالة إلى ٩٨٨، على مدار ٢٤ ساعة', true],
  ['mental', 'Llama o escribe al 988, 24 horas.', true],
  ['emergency', 'Llama al 911 ahora, 24 horas.', true],
];

describe('evasion table', () => {
  it.each(EVASION_TABLE)('%s %j passes: %s', (kind, text, pass) => {
    expect(crisisReplyViolation(kind, text) === null).toBe(pass);
  });
});

describe('links', () => {
  it.each([
    ['lowercase scheme', 'Call or text 988, or chat at https://example.org/help.'],
    ['www', 'Call or text 988 or visit www.example.org.'],
    ['bare domain', 'Call or text 988, or see example.org'],
    ['uppercase domain', 'Call 988 or visit EXAMPLE.COM'],
    ['mixed-case domain', 'Call 988 or visit Example.Org now'],
    ['uppercase country domain', 'call 988 EXAMPLE.CA'],
    ['full-width scheme', 'Call 988 or see ＨＴＴＰＳ：／／ＥＸＡＭＰＬＥ．ＯＲＧ'],
    ['full-width www', 'Call 988 or see ｗｗｗ．ｅｘａｍｐｌｅ'],
    ['non-Latin domain', 'Call 988 or see пример.испытание'],
    ['ideographic full stop', 'Call 988 or see example。com'],
    ['bracketed dot', 'Call 988 or see example[.]com'],
    ['spaced dot', 'Call 988 or see example . com'],
  ])('%s is a link', (_name, text) => {
    expect(crisisReplyViolation('mental', text)).toBe('link');
  });

  it.each([
    ['abbreviation', 'If you are thinking of ending it, e.g. tonight, call or text 988.'],
    ['full stop then a sentence', 'Call 988. Then rest.'],
    ['Chinese full stop', '请拨打988。全天都有人接听。'],
    ['country abbreviation', 'In the U.S. and Canada, call or text 988.'],
  ])('%s is not a link', (_name, text) => {
    expect(crisisReplyViolation('mental', text)).toBeNull();
  });
});
