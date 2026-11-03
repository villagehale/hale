import { describe, expect, it } from 'vitest';
import { hasEncodingCorruption } from './encoding';

describe('hasEncodingCorruption', () => {
  it.each([
    ['replacement char', 'Broken \ufffd text'],
    ['1252 é', 'dÃ©but'],
    ['1252 û', 'aoÃ»t'],
    ['1252 ’', 'donâ€™t'],
    ['1252 —', 'Hale â€” today'],
    ['1252 emoji', 'ðŸŽ‰ bravo'],
    ['1252 ț', 'mulÈ›umesc'],
    ['1252 Chinese', 'æŠ¥å\u0090\u008d'],
    ['1252 Cyrillic', 'Ð\u00a0ÐµÐ³Ð¸Ñ\u0081Ñ‚Ñ€Ð°Ñ†Ð¸Ñ\u008f'],
    ['1252 Arabic', 'Ø§Ù„ØªØ³Ø¬ÙŠÙ„'],
    ['1252 à before NBSP', 'Rendez-vous Ã\u00a0 9 h'],
    ['Latin-1 emoji', 'ð\u009f\u008e\u0089 bravo'],
    ['Latin-1 ß', 'GrÃ¼Ã\u009fe'],
    ['8859-2 é', 'dĂŠbut'],
    ['8859-2 ö', 'schĂśn'],
    ['8859-16 é', 'dĂ©but'],
    ['8859-16 û', 'aoĂ»t'],
    ['8859-16 ê', 'ĂȘtes'],
    ['8859-16 è', 'aprĂšs'],
    ['1257 é', 'dĆ©but'],
    ['1257 è', 'aprĆØs'],
    ['1257 û', 'aoĆ»t'],
    ['double garbling', 'ÃƒÂ©tÃƒÂ©'],
    ['mixed with a real ’', 'd’aprĂšs'],
    ['one garbled word in clean text', 'Inscription en aoÃ»t'],
    ['garbled word glued to clean text by an emoji', 'aoÃ»t🎉été'],
  ])('holds UTF-8 read back through a legacy charset: %s', (_name, message) => {
    expect(hasEncodingCorruption(message)).toBe(true);
  });

  it.each([
    ['café + NBSP »', '« Un café\u00a0»'],
    ['voilà + NBSP »', '« Voilà\u00a0»'],
    ['réservé + NBSP »', 'Il a dit « c’est réservé\u00a0» hier.'],
    ['French typography', '«\u00a0C’est fermé\u00a0», dit-elle\u00a0; à bientôt\u00a0!'],
    ['caps + NBSP !', 'BON ÉTÉ\u00a0!'],
    ['caps in curly quotes', '“ÉTÉ”'],
    ['ß + closing quote', '„Das Maß“'],
    ['ß + en dash', 'Fuß–Ball'],
    ['caps ANNULÉ + NBSP', 'ANNULÉ\u00a0!'],
    ['caps CONFIRMÉ + NBSP', 'C’est CONFIRMÉ\u00a0?'],
    ['caps PASSÉ in guillemets', '« PASSÉ\u00a0»'],
    ['caps CAFÉ in curly quotes', '“CAFÉ”'],
    ['caps CAFÉ + ellipsis', 'CAFÉ…'],
    ['caps CAFÉ + apostrophe', 'CAFÉ’S menu'],
    ['curly quotes, dashes, NBSP €', '“Café” — l’été’s début – coût 5\u00a0€…'],
    ['NBSP in English', 'Deadline is 7:00\u00a0AM — don’t miss it.'],
    [
      'French accents',
      'Ça commence à 9 h — déjà complet ? Où ça ? Noël, Zoë, maïs, aîné, côté, piqûre',
    ],
    ['Spanish', '¿Qué tal? ¡Olé! Mañana — niño, año, ÁNIMO'],
    ['Polish', 'Zażółć gęślą jaźń; ŁÓDŹ, ŚWIĘTO'],
    ['Czech + Romanian', 'Příliš žluťoučký kůň; mulțumesc, ÎNSCRIERI ȘI ȚARĂ'],
    ['Vietnamese', 'Đăng ký mở lúc 9 giờ sáng — cảm ơn bạn.'],
    ['Chinese', '报名开放时间尚未确定。'],
    ['Arabic', 'مرحبًا، تفتح التسجيلات في أغسطس.'],
    ['Russian', 'Регистрация открывается в 9 утра.'],
    ['Punjabi', 'ਰਜਿਸਟ੍ਰੇਸ਼ਨ ਸਵੇਰੇ 9 ਵਜੇ ਖੁੱਲ੍ਹਦੀ ਹੈ।'],
    ['emoji, ZWJ, skin tone, VS16', '👨\u200d👩\u200d👧\u200d👦 👍🏽 🏳\ufe0f\u200d🌈 🎉 ❤\ufe0f'],
    ['decomposed accents', 'e\u0301te\u0301'],
    ['symbols', '2×3 = 6, ½ cup, 20 °C, n° 3, Café™'],
    ['upstream French row', 'début août êtes d’après — été, Noël, Zoë'],
    ['upstream Central European row', 'Łódź, București, Český Krumlov, Ăngela'],
    ['Lithuanian', 'Ačiū! Registracija prasidės rugpjūčio mėnesį.'],
    ['Latvian caps Ā + ellipsis', 'JĀ…'],
  ])('leaves correct text alone: %s', (_name, message) => {
    expect(hasEncodingCorruption(message)).toBe(false);
  });
});
