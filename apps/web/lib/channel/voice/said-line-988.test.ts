import { describe, expect, it } from 'vitest';
import { type CrisisKind, crisisReplyViolation, readerConfirmationViolation } from './said-line';

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
    expect(crisisReplyViolation('mental', text, null)).toBeNull();
  });

  it.each([
    ['spaced', 'Call 911. Or 9 8 8.'],
    ['full-width', '拨打911或９８８'],
    ['comma-spelled after a word', '911, or 9,8,8'],
    ['Arabic-Indic', 'اتصل بـ ٩١١ أو ٩٨٨'],
  ])('an emergency reply with a %s 988 is refused as emergency_988', (_name, text) => {
    expect(crisisReplyViolation('emergency', text, null)).toBe('emergency_988');
  });

  it('positive control: an emergency reply with 911 alone passes', () => {
    expect(crisisReplyViolation('emergency', 'Call 911 now.', null)).toBeNull();
    expect(crisisReplyViolation('emergency', 'Appelle le 9-1-1 maintenant.', null)).toBeNull();
  });

  it('does not invent 988 from unrelated digits', () => {
    expect(crisisReplyViolation('mental', 'Call 911.', null)).toBe('missing_line');
    expect(crisisReplyViolation('mental', '9 1 1', null)).toBe('missing_line');
    expect(crisisReplyViolation('emergency', 'Call 911 now. 98 is the bus; 8 kids', null)).toBe(
      'other_number',
    );
  });
});

describe('the required line', () => {
  it('a reply without it is missing_line', () => {
    expect(crisisReplyViolation('mental', 'I am here with you.', null)).toBe('missing_line');
    expect(crisisReplyViolation('emergency', 'Call or text 988.', null)).toBe('missing_line');
    expect(crisisReplyViolation('emergency', 'Call 9 1 2.', null)).toBe('missing_line');
  });

  it('a longer number that contains the digits is not the line', () => {
    expect(crisisReplyViolation('mental', 'Appelle le 9-8-8 ou le 911.', null)).toBeNull();
    for (const text of ['Room 49881.', 'Call 1988.']) {
      expect(crisisReplyViolation('mental', text, null)).toBe('missing_line');
    }
    expect(crisisReplyViolation('emergency', 'Ref 19112.', null)).toBe('missing_line');
  });

  it('names other_number, not missing_line, when the line is there next to another number', () => {
    // The re-ask tells the writer why: a draft that carried 988 did not miss it.
    expect(crisisReplyViolation('mental', 'Call or text 988, 24-8.', null)).toBe('other_number');
    expect(crisisReplyViolation('mental', 'Salle 4-988-12.', null)).toBe('other_number');
    expect(crisisReplyViolation('emergency', 'Call 911 555 0100', null)).toBe('other_number');
    // Positive control: with no 988 at all, it is still missing_line.
    expect(crisisReplyViolation('mental', 'Call 911, 24-8.', null)).toBe('missing_line');
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
    expect(crisisReplyViolation(kind, text, null)).toBeNull();
  });

  it('a Bengali run-on is a longer number, not the line', () => {
    expect(crisisReplyViolation('mental', 'Call 988 ৫৫৫ ০১০০', null)).toBe('other_number');
    expect(crisisReplyViolation('mental', 'Call 988 now, or ৫৫৫ ০১০০', null)).toBe('other_number');
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
  // A fictional short code: US and Canadian short codes never start with 0.
  ['mental', '012012', false],
  ['mental', 'Text 012012 or call 988.', false],
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
  // Round 4 fix: day-of-week forms; each hours form ends at a word boundary.
  ['mental', 'Call or text 988, 24 hours a day, 7 days a week.', true],
  ['mental', 'Llama o escribe al 988, las 24 horas, los 7 días de la semana.', true],
  ['mental', '请拨打988，24小时，每周7天。', true],
  ['mental', '请拨打988，24小时都有人接听。', true],
  ['mental', 'اتصل بـ ٩٨٨ على مدار ٢٤ ساعة، ٧ أيام في الأسبوع', true],
  ['mental', 'Call 988, 7 days 5550100', false],
  ['mental', 'Call 988, 24 hommes', false],
  ['mental', 'Call 988, 24 hiver', false],
  // Round 5: natural hours forms a correct reply uses.
  ['mental', 'Call or text 988, 24-7.', true],
  ['emergency', 'Call 911 now, 24-7.', true],
  ['mental', 'Call or text 988, 24x7.', true],
  ['mental', 'Call or text 988, 24 hrs a day.', true],
  ['mental', 'Le 988 répond 24 heures par jour.', true],
  ['mental', 'Appelle le 9-8-8, 24/24 et 7/7.', true],
  ['mental', '請撥打988，24小時都有人接聽。', true],
  ['mental', '請撥打 988，24 小時，每週 7 天。', true],
  ['mental', '请拨打 988，24 小时，每周 7 天。', true],
  ['mental', 'कृपया 988 पर कॉल करें, 24 घंटे, 7 दिन।', true],
  ['mental', 'कृपया 988 पर कॉल करें, 24x7 उपलब्ध।', true],
  ['mental', 'Call 988, 24-75', false],
  ['mental', 'Call 988, 24x75', false],
  ['mental', 'Call 988, 24 hrsx 5550100', false],
  // Hours forms joined to each other dial a code ('24-7-24-7' is 247247).
  ['mental', 'Text 24-7-24-7 now. Call 988.', false],
  ['mental', 'Call 988, 24/7/24/7.', false],
  ['mental', 'Call 988, 24x7 24x7.', false],
  ['mental', 'Call 988, 24/7 7/7.', false],
  ['mental', 'Call 988, 24/24 24/24.', false],
  ['emergency', 'Call 911, 24-7 24-7.', false],
  // Positive control: one hours-per-day form then one days-per-week form is not a code.
  ['mental', 'Appelle le 9-8-8, 24/24 7/7.', true],
  // Round 6: the order is day then week; a week form first is not an hours phrase.
  ['mental', 'Call 988, 7/7 24/24.', false],
  ['mental', 'Appelle le 988, 7 j/7 24 h/24.', false],
  // Round 6: a crisis line glued to an hours form by a hyphen or slash, with no space,
  // is one dialable code.
  ['mental', 'Call 988-24/7.', false],
  ['mental', 'Call 24/7-988.', false],
  ['mental', 'Call 988/24h.', false],
  ['mental', 'Appelle le 9-8-8-24/24.', false],
  ['emergency', 'Call 911-24/7.', false],
  ['mental', 'Call 988–24/7.', false],
  // Positive controls: a space or a bracket between them is a phrase, not a code.
  ['mental', 'Call 988, 24/7.', true],
  ['mental', 'Call 988 (24/7).', true],
  ['mental', 'Call 988 - 24/7.', true],
  ['emergency', 'Call 911, 24/7.', true],
  // Round 6 fix: any joiner other than a space or a bracket glues them, invisible ones too.
  ['mental', 'Call 988.24/7.', false],
  ['mental', 'Call 988\u221224/7.', false],
  ['mental', 'Call 988-\u200b24/7.', false],
  ['mental', 'Call 988\u200b24/7.', false],
  ['mental', 'Call 988\u00ad24/7.', false],
  ['mental', 'Call 988_24/7.', false],
  ['mental', 'Call 988+24/7.', false],
  ['mental', 'Call 988:24/7.', false],
  ['mental', 'Call 988~24/7.', false],
  ['mental', 'Call 988\u00b724/7.', false],
  ['mental', 'Call 988\u204424/7.', false],
  ['mental', 'Call 988\\24/7.', false],
  ['mental', 'Call 988,24/7.', false],
  ['mental', 'Call 24/7.988.', false],
  // Positive controls: a CJK comma is a phrase break; a space hidden behind a Cf mark still is one.
  ['mental', '请拨打988、24小时。', true],
  ['mental', 'Call 988\u200b 24/7.', true],
];

describe('evasion table', () => {
  it.each(EVASION_TABLE)('%s %j passes: %s', (kind, text, pass) => {
    expect(crisisReplyViolation(kind, text, null) === null).toBe(pass);
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
    ['Latin name, Han ending', 'Call 988 or see example.中国'],
    ['two-letter pair, no closing dot', 'Call 988 or see EX.CO'],
    ['two-letter pair, then a domain', 'Call 988 or see EE.UU.com'],
  ])('%s is a link', (_name, text) => {
    expect(crisisReplyViolation('mental', text, null)).toBe('link');
  });

  it.each([
    ['abbreviation', 'If you are thinking of ending it, e.g. tonight, call or text 988.'],
    ['full stop then a sentence', 'Call 988. Then rest.'],
    ['Chinese full stop', '请拨打988。全天都有人接听。'],
    ['country abbreviation', 'In the U.S. and Canada, call or text 988.'],
    ['Spanish country abbreviation', 'En EE.UU., llama o escribe al 988.'],
    ['ASCII full stop in Chinese', '请拨打988.你并不孤单。'],
  ])('%s is not a link', (_name, text) => {
    expect(crisisReplyViolation('mental', text, null)).toBeNull();
  });
});

// The writer was told a language. A reply with no letter of that language's script
// (mojibake, or the wrong language) is not sent. Checked on model output only.
const ARABIC_AS_CP1251 = 'Ш§ШЄШµЩ„ Ш§Щ„Ш¢Щ† ШЁШ§Щ„Ш±Щ‚Щ… 911.';
const ARABIC_AS_LATIN1 = 'Ø§ØªØµÙ„ Ø§Ù„Ø¢Ù† 911.';

describe('the reply is in the script of its language', () => {
  it.each([
    ['Arabic read as cp1251', 'emergency', ARABIC_AS_CP1251, 'ar'],
    ['Arabic read as Latin-1', 'emergency', ARABIC_AS_LATIN1, 'ar'],
    ['English for a Chinese reply', 'mental', 'Call or text 988.', 'zh'],
    ['English for a Traditional Chinese reply', 'mental', 'Call or text 988.', 'zh-tw'],
    ['English for a Hindi reply', 'mental', 'Call or text 988.', 'hi'],
    ['Arabic for a French reply', 'mental', 'اتصل على ٩٨٨', 'fr'],
    ['Latin for a Punjabi reply', 'mental', 'Call or text 988.', 'pa'],
    ['Cyrillic for a Punjabi reply', 'mental', 'Позови 988.', 'pa'],
  ] as const)('%s is wrong_script', (_name, kind, text, language) => {
    expect(crisisReplyViolation(kind, text, language)).toBe('wrong_script');
  });

  it.each([
    ['Arabic', 'emergency', 'اتصل بـ ٩١١ الآن', 'ar'],
    [
      'Arabic naming an English service',
      'mental',
      'اتصل أو أرسل إلى 988، 9-8-8 Suicide Crisis Helpline',
      'ar',
    ],
    ['Chinese', 'mental', '请拨打988', 'zh'],
    ['Traditional Chinese', 'mental', '請撥打988', 'zh-tw'],
    ['Hindi', 'mental', 'कृपया ९८८ पर कॉल करें', 'hi'],
    ['French', 'mental', 'Appelle ou texte le 9-8-8.', 'fr-ca'],
    ['Traditional Chinese for zh', 'mental', '請撥打988', 'zh'],
    ['Simplified Chinese for zh-hant', 'mental', '请拨打988', 'zh-hant'],
    ['Punjabi in Gurmukhi', 'mental', 'ਕਿਰਪਾ ਕਰਕੇ 988 ਤੇ ਕਾਲ ਕਰੋ', 'pa'],
    ['Punjabi in Shahmukhi', 'mental', 'مہربانی کر کے 988 تے کال کرو', 'pa'],
    ['Serbian in Latin', 'emergency', 'Pozovi 911 odmah.', 'sr'],
    ['Serbian in Cyrillic', 'emergency', 'Позови 911 одмах.', 'sr'],
  ] as const)('%s in its own script passes', (_name, kind, text, language) => {
    expect(crisisReplyViolation(kind, text, language)).toBeNull();
  });

  it('no language, or one with no known script, is not checked', () => {
    expect(crisisReplyViolation('emergency', ARABIC_AS_CP1251, null)).toBeNull();
    expect(crisisReplyViolation('emergency', ARABIC_AS_CP1251, 'xx')).toBeNull();
    // Positive control: the same text is refused once the language is known.
    expect(crisisReplyViolation('emergency', ARABIC_AS_CP1251, 'ar')).toBe('wrong_script');
  });

  it('a number or link violation is still named first', () => {
    expect(crisisReplyViolation('mental', 'Call 911.', 'zh')).toBe('missing_line');
  });
});

// One letter of the script is not enough: most of the reply's letters are in it, counted
// after NFKC with format characters gone, the crisis line's own name and the numbers left
// out. It tells writing systems apart only; fr, es and en are all Latin.
describe('the reply is mostly in the script of its language', () => {
  it.each([
    ['an English call to act with one Arabic word', 'mental', 'Call 988 الآن', 'ar'],
    [
      'an English reply ending in an Arabic phrase',
      'mental',
      'Please call or text 988 right now. أنا هنا',
      'ar',
    ],
    ['an English reply with one Hindi word', 'mental', 'Please call or text 988 now. मदद', 'hi'],
    ['a Cyrillic reply with one Arabic word', 'emergency', 'Позвоните 911 الآن', 'ar'],
    ['English split by zero-width spaces', 'mental', 'C​all or text 988 n​ow ​الآن', 'ar'],
    [
      'full-width English with one Han character',
      'mental',
      'Ｃａｌｌ ｏｒ ｔｅｘｔ 988 ｎｏｗ 请',
      'zh',
    ],
    ['English around the line name', 'mental', 'Call the Suicide Crisis Helpline 988 الآن', 'ar'],
  ] as const)('%s is wrong_script', (_name, kind, text, language) => {
    expect(crisisReplyViolation(kind, text, language)).toBe('wrong_script');
  });

  it.each([
    [
      'Hindi naming the US line in English',
      'mental',
      'आप अकेले नहीं हैं: 988 Suicide & Crisis Lifeline को 988 पर कॉल करें',
      'hi',
    ],
    [
      'Chinese naming the US line in full-width letters',
      'mental',
      '请拨打988 Ｓｕｉｃｉｄｅ ＆ Ｃｒｉｓｉｓ Ｌｉｆｅｌｉｎｅ',
      'zh',
    ],
    [
      'Arabic naming the Canada line split by zero-width spaces',
      'mental',
      'اتصل أو أرسل إلى 988، 9-8-8 Sui​cide Cri​sis Help​line',
      'ar',
    ],
  ] as const)('%s passes', (_name, kind, text, language) => {
    expect(crisisReplyViolation(kind, text, language)).toBeNull();
  });

  it('a reply of only the line name and its number is not in any language', () => {
    expect(crisisReplyViolation('mental', '9-8-8 Suicide Crisis Helpline 988', 'en')).toBe(
      'wrong_script',
    );
    // Positive control: one word of the language around it is enough.
    expect(
      crisisReplyViolation('mental', 'Call the 9-8-8 Suicide Crisis Helpline 988', 'en'),
    ).toBeNull();
  });
});

// A stop or start confirmation is the reader's text, written while it read the parent's
// words. Its job is to say stop or start, so any number (an hours form too) or link in
// it is refused.
describe('reader confirmation: no number, no link', () => {
  it.each([
    ['a URL', "You're off the list. Come back at https://example.org/start"],
    ['a bare domain', "You're off the list, see example.org"],
    ['a phone number', "You're off the list. Questions? 555 0100"],
    ['a crisis line', 'Done, no more texts. If you need someone, text 988.'],
    ['a spelled number', 'Okay, stopping. Call 5-5-5-0-1-0-0 any time.'],
    ['chained hours forms', 'Done, no more texts. For help text 24/7/24/7.'],
    ['chained dashed hours forms', 'Done, no more texts. For help text 24-7-24-7.'],
    ['repeated hours forms', 'Done, no more texts. For help text 24x7 24x7.'],
    ['an hours form', 'Done, no more texts. Call 24 hrs.'],
    ['an hours form in a welcome', "Welcome back! Hale's here 24/7."],
  ])('%s is refused', (_name, text) => {
    expect(readerConfirmationViolation(text)).not.toBeNull();
  });

  it('names a link as link and a number as other_number', () => {
    expect(readerConfirmationViolation('Done. See example.org')).toBe('link');
    expect(readerConfirmationViolation('Done. Call 555 0100')).toBe('other_number');
  });

  it.each([
    ['Got it, no more texts from Hale. Text START if you change your mind.'],
    ["C'est noté, plus de messages. Écris START si tu changes d'avis."],
    ['好的，不再给你发消息了。想回来就发 START。'],
    ['حسناً، لن نراسلك بعد الآن.'],
    ["Welcome back! Hale's here any time."],
  ])('positive control: %j passes', (text) => {
    expect(readerConfirmationViolation(text)).toBeNull();
  });
});
