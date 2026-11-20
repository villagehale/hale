import { describe, expect, it } from 'vitest';
import { hasGarbledText, holdsGarbledText } from './garbled-text.js';

describe('garbled text: UTF-8 read back in a one-byte code page', () => {
  // Each from a recorded draw of a Hale writer or judge (apps/worker/evals/cache).
  it.each([
    ['windows-1250, French', "je n'ai pas payĂ©. Rien n'a Ă©tĂ© dĂ©bitĂ©."],
    ['windows-874, French', 'Natation prรฉscolaire sam. 9h00'],
    ['windows-874, a name', "And Lรฉa's Storytime is tomorrow too"],
    ['windows-1252, a name', 'Storytime for LÃ©a, 1:30-2:15 PM'],
    ['windows-1250, Spanish', 'Esa presentaciĂłn no va a pasar'],
    ['windows-1252, a curly apostrophe', 'itâ€™s on Sunday'],
  ])('refuses %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });

  // VIL-608: the said-line writer's Spanish soft close, verbatim (voice/said-line.test.ts).
  it.each([
    [
      'ISO-8859-7',
      'La presentaciΓ³n de la que te hablΓ© no va a suceder. Las otras presentaciones siguen en pie.',
    ],
    ['windows-1256', 'Esa presentaciأ³n que te comentأ© no se va a dar. Las otras siguen en pie.'],
    ['ISO-8859-13', 'Esa presentaciĆ³n no va a seguir adelante. Las demĆ”s presentaciones siguen.'],
  ])('refuses a recorded writer draw read back in %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });

  // One honest Spanish line as UTF-8 bytes, read back through every code page Node can
  // decode. Each reading is what a parent would see.
  const SPANISH = 'Esa presentación que te comenté, también Léa y Noël, aquí está.';
  it.each([
    'windows-1250',
    'windows-1251',
    'windows-1252',
    'windows-1253',
    'windows-1254',
    'windows-1255',
    'windows-1256',
    'windows-1257',
    'windows-1258',
    'windows-874',
    'iso-8859-2',
    'iso-8859-4',
    'iso-8859-5',
    'iso-8859-7',
    'iso-8859-13',
    'iso-8859-15',
    'macintosh',
    'x-mac-cyrillic',
    'ibm866',
    'koi8-r',
    'koi8-u',
  ])('refuses Spanish read back in %s', (page) => {
    const garbled = new TextDecoder(page).decode(new TextEncoder().encode(SPANISH));
    expect(garbled).not.toBe(SPANISH);
    expect(hasGarbledText(garbled)).toBe(true);
  });

  it.each([
    ['windows-1252, a dash between spaces', 'Swim Sat â€” 9:00 at the pool'],
    ['windows-1252, Arabic', 'Ø§Ù„Ø³Ø¨Øª Ø§Ù„Ø³Ø§Ø¹Ø© 9'],
    ['windows-1252, an emoji', 'ðŸŽ‰ bravo'],
    ['windows-1252, Chinese glued to a name', 'Adaçš„ Preschool Swim'],
    ['windows-1252, a lone "à" before a no-break space', 'Rendez-vous Ã\u00a0 9 h'],
  ])('refuses a garbled run outside a Latin word: %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });

  // A broken character glued to an honest one: the run as a whole is not UTF-8, the
  // broken part at its Latin end is.
  it.each([
    ['before an ellipsis', 'On se voit au cafÃ©… demain'],
    ['before a closing quote', 'Elle a dit “cafÃ©” hier'],
    ['before a no-break space and a guillemet', '« C’est fermÃ©\u00a0»'],
    ['before a no-break space and a bang', 'C’est confirmÃ©\u00a0!'],
    ['before an honest ß', 'GrÃ¶ße'],
    ['after an honest ü', 'GrüÃŸe'],
    ['windows-874, before an ellipsis', 'On se voit au cafรฉ… demain'],
    ['ISO-8859-7, before an honest ß', 'GrΓ¶ße'],
    ['an opening guillemet before a no-break space', 'Il a dit Â«\u00a0oui\u00a0Â»'],
    ['a dash glued to Chinese', '拍照日â€”请确认'],
    ['an ellipsis glued to Chinese', '两个适合â€¦的'],
  ])('refuses a garbled character glued to an honest one: %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });

  it.each([
    ['ISO-8859-7, a lone "à"', 'Rendez-vous Γ\u00a0 9 h'],
    ['windows-1256, a lone "à"', 'Rendez-vous أ\u00a0 9 h'],
    ['windows-874, a lone "à"', 'Rendez-vous ร\u00a0 9 h'],
    ['windows-874, a dash between spaces', 'Swim Sat โ€” 9:00 at the pool'],
    ['windows-874, a dash between digits', 'Swim 9:00 โ€“ 10:00'],
    ['windows-1250, Chinese standing alone', 'ĺ‘¨ 10:00'],
  ])('refuses a garbled run outside a Latin word in any code page: %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });

  // From the older registration check (#1016), folded in here.
  it.each([
    ['1252 û', 'aoÃ»t'],
    ['1252 ț', 'mulÈ›umesc'],
    ['8859-2 é', 'dĂŠbut'],
    ['8859-2 ö', 'schĂśn'],
    ['8859-16 ê', 'ĂȘtes'],
    ['8859-16 è', 'aprĂšs'],
    ['1257 é', 'dĆ©but'],
    ['1257 è', 'aprĆØs'],
    ['double garbling', 'ÃƒÂ©tÃƒÂ©'],
    ['mixed with a real ’', 'd’aprĂšs'],
    ['garbled word glued to clean text by an emoji', 'aoÃ»t🎉été'],
    ['garbled word beside a correct accented word', 'Café prêt : dÃ©but'],
  ])('refuses %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });

  it.each([
    ['French', "Rien n'a été débité : l’été, « créée », Noël, naïve, Œuvre, ça, où, déjà."],
    ['Spanish', '¿Sábado o domingo? Ya están en la lista, mamá.'],
    ['German', 'Schwimmkurs für Ada, Größe egal.'],
    ['German quotes after ß', 'Sie schrieb „Gruß“ und „Grüße“ zurück, Fuß–Ball.'],
    ['Polish', 'Zajęcia w sobotę o 9:00, „Łódź”, źle, żółć, gęś.'],
    ['Polish capitals', 'GĘŚ, MĘŻCZYZNA, KSIĘŻYC, ZAŻÓŁĆ GĘŚLĄ JAŹŃ, ŁÓDŹ, ŚWIĘTO'],
    ['Czech', 'Plavání v sobotu – přihláška je hotová, „ČEZ“.'],
    ['Czech capitals', 'PÍŠE, Příliš žluťoučký kůň'],
    ['Romanian', 'mulțumesc, ÎNSCRIERI ȘI ȚARĂ, București'],
    ['Lithuanian', 'Ačiū! Registracija prasidės rugpjūčio mėnesį.'],
    ['Vietnamese', 'Lớp bơi thứ Bảy lúc 9 giờ, đã đăng ký.'],
    ['French capitals and punctuation', 'CAFÉ… OUVERT, “CAFÉ”, CAFÉ’S menu, « PASSÉ\u00a0»'],
    ['French capitals before a no-break space', 'BON ÉTÉ\u00a0! C’est CONFIRMÉ\u00a0?'],
    ['French typography', '«\u00a0C’est fermé\u00a0», dit-elle\u00a0; à bientôt\u00a0! Voilà\u00a0»'],
    ['a quoted word ending in an accent', 'She said “un café…” and left.'],
    ['a quoted Spanish word ending in an accent', 'Dijo “ya voy, mamá…” y colgó.'],
    ['Latvian capital before an ellipsis', 'JĀ…'],
    ['Chinese', 'Ada 的 Preschool Swim 周日 10:00 还没有确认报名成功。'],
    ['Chinese glued to a name', 'Ada的Preschool Swim周日开始。'],
    ['CJK punctuation', '「周六」上午九点，在游泳池。好的！（确认）'],
    ['Chinese with Western punctuation', '拍照日——请确认……“好”的，《周六》—好'],
    ['Japanese', '土曜日の9時に水泳教室があります。'],
    ['Korean', '토요일 9시에 수영 수업이 있어요.'],
    ['Arabic', 'درس السباحة يوم السبت الساعة 9، تم التسجيل.'],
    ['Hebrew', 'שיעור שחייה בשבת בשעה 9.'],
    ['Hindi', 'शनिवार को 9 बजे तैराकी की कक्षा है।'],
    ['Punjabi', 'ਰਜਿਸਟ੍ਰੇਸ਼ਨ ਸਵੇਰੇ 9 ਵਜੇ ਖੁੱਲ੍ਹਦੀ ਹੈ।'],
    ['Russian', 'Регистрация открывается в 9 утра. ЗАНЯТИЕ В СУББОТУ.'],
    ['Ukrainian', 'Заняття з плавання в суботу о 9:00, ґанок, їжа.'],
    ['Greek', 'Μάθημα κολύμβησης το Σάββατο στις 9. ΕΓΓΡΑΦΗ ΟΚ.'],
    ['emoji', 'See you Saturday 🏊‍♀️👨‍👩‍👧 🇨🇦 ❤️ 👍🏽 done🎉'],
    ['punctuation', 'Sun 10:00 — $98… “ok” • 20 °C ±2 © ™ 2×3 ½ cup n° 3 Café™ 5\u00a0€…'],
    ['decomposed accents', 'été'],
    ['line breaks and tabs', 'Sat 9:00\nSun 10:00\r\n\tpool'],
    ['Thai two-letter words standing alone', 'ยก ลด สด รก วัน'],
    ['Russian with no-break spaces', 'Её нет. В\u00a0субботу в\u00a09, К\u00a0сожалению'],
    ['Greek article', 'Η πισίνα, Ο Νίκος'],
    ['a price after an accented word', 'Un café\u00a0€ 3, crème\u00a0$ 4'],
    // "à »" alone is UTF-8 in windows-1252, but not as a character a writer means.
    ['a quoted "à" in French typography', 'On écrit «\u00a0à\u00a0» ici'],
    // "รถ" reads back as UTF-8 "ö": a Thai word, not a broken letter inside a Latin one.
    ['Thai', 'รถ 2 คัน'],
    // "เขต" reads back in windows-874 as one whole UTF-8 character. Thai is written in
    // windows-874, so that page is never read for a run outside a Latin word.
    ['Thai standing alone', 'เขต 3 ใกล้บ้าน'],
  ])('sends %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(false);
  });
});

describe('garbled text: the rest of the older registration check (#1016)', () => {
  it.each([
    ['1252 é', 'dÃ©but'],
    ['1252 ’', 'donâ€™t'],
    ['1252 —', 'Hale â€” today'],
    ['1252 Chinese', 'æŠ¥å\u0090\u008d'],
    ['1252 Cyrillic', 'Ð\u00a0ÐµÐ³Ð¸Ñ\u0081Ñ‚Ñ€Ð°Ñ†Ð¸Ñ\u008f'],
    ['Latin-1 emoji', 'ð\u009f\u008e\u0089 bravo'],
    ['Latin-1 ß', 'GrÃ¼Ã\u009fe'],
    ['8859-16 é', 'dĂ©but'],
    ['8859-16 û', 'aoĂ»t'],
    ['1257 û', 'aoĆ»t'],
    ['one garbled word in clean text', 'Inscription en aoÃ»t'],
    ['correct accent, then an emoji, then a garbled word', 'é🎉dÃ©but'],
  ])('refuses %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });

  it.each([
    ['café + NBSP »', '« Un café\u00a0»'],
    ['voilà + NBSP »', '« Voilà\u00a0»'],
    ['réservé + NBSP »', 'Il a dit « c’est réservé\u00a0» hier.'],
    ['ß + closing quote', '„Das Maß“'],
    ['caps ANNULÉ + NBSP', 'ANNULÉ\u00a0!'],
    ['curly quotes, dashes, NBSP €', '“Café” — l’été’s début – coût 5\u00a0€…'],
    ['NBSP in English', 'Deadline is 7:00\u00a0AM — don’t miss it.'],
    ['French accents', 'Ça commence à 9 h — déjà complet ? Où ça ? Noël, Zoë, maïs, aîné, côté'],
    ['Spanish', '¿Qué tal? ¡Olé! Mañana — niño, año, ÁNIMO'],
    ['Vietnamese', 'Đăng ký mở lúc 9 giờ sáng — cảm ơn bạn.'],
    ['emoji, ZWJ, skin tone, VS16', '👨\u200d👩\u200d👧\u200d👦 👍🏽 🏳\ufe0f\u200d🌈 🎉 ❤\ufe0f'],
    ['upstream French row', 'début août êtes d’après — été, Noël, Zoë'],
    ['upstream Central European row', 'Łódź, București, Český Krumlov, Ăngela'],
  ])('sends %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(false);
  });
});

describe('garbled text: characters no writer means', () => {
  it.each([
    ['a replacement character', 'Swim on Sat\uFFFDrday at 9'],
    ['an unpaired high surrogate', 'See you Saturday \uD83C at 9'],
    ['an unpaired low surrogate', 'See you Saturday \uDFCA at 9'],
    ['a NUL', 'Swim at 9\u0000'],
    ['an escape', 'Swim \u001b[0m at 9'],
    ['a C1 control', 'Swim\u0085at 9'],
    ['a DEL', 'Swim at 9\u007f'],
  ])('refuses %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });
});

describe('holdsGarbledText: any string inside a structured answer', () => {
  it('finds a garbled string nested in arrays and objects', () => {
    expect(holdsGarbledText({ texts: ['Swim is Saturday.', { body: 'Storytime for LÃ©a' }] })).toBe(
      true,
    );
  });

  it('passes clean values of every shape (positive control)', () => {
    expect(
      holdsGarbledText({
        texts: ['Natation préscolaire, samedi.', '周六'],
        n: 3,
        ok: true,
        x: null,
      }),
    ).toBe(false);
  });
});
