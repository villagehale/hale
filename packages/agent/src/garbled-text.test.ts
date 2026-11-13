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

  it.each([
    ['windows-1252, a dash between spaces', 'Swim Sat â€” 9:00 at the pool'],
    ['windows-1252, Arabic', 'Ø§Ù„Ø³Ø¨Øª Ø§Ù„Ø³Ø§Ø¹Ø© 9'],
  ])('refuses a garbled run that touches no Latin letter: %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(true);
  });

  it.each([
    ['French', "Rien n'a été débité : l’été, « créée », Noël, naïve, Œuvre, ça, où, déjà."],
    ['Spanish', '¿Sábado o domingo? Ya están en la lista, mamá.'],
    ['German', 'Schwimmkurs für Ada, Größe egal.'],
    ['German quotes after ß', 'Sie schrieb „Gruß“ und „Grüße“ zurück.'],
    ['Polish', 'Zajęcia w sobotę o 9:00, „Łódź”, źle, żółć, gęś.'],
    ['Czech', 'Plavání v sobotu – přihláška je hotová, „ČEZ“.'],
    ['Vietnamese', 'Lớp bơi thứ Bảy lúc 9 giờ, đã đăng ký.'],
    ['Chinese', 'Ada 的 Preschool Swim 周日 10:00 还没有确认报名成功。'],
    ['CJK punctuation', '「周六」上午九点，在游泳池。好的！（确认）'],
    ['Japanese', '土曜日の9時に水泳教室があります。'],
    ['Korean', '토요일 9시에 수영 수업이 있어요.'],
    ['Arabic', 'درس السباحة يوم السبت الساعة 9، تم التسجيل.'],
    ['Hebrew', 'שיעור שחייה בשבת בשעה 9.'],
    ['Hindi', 'शनिवार को 9 बजे तैराकी की कक्षा है।'],
    ['emoji', 'See you Saturday 🏊‍♀️👨‍👩‍👧 🇨🇦 ❤️ 👍🏽'],
    ['punctuation', 'Sun 10:00 — $98… “ok” • 20 °C ±2 © ™'],
    ['line breaks and tabs', 'Sat 9:00\nSun 10:00\r\n\tpool'],
    // "รถ" reads back as UTF-8 "ö": a Thai word, not a broken letter inside a Latin one.
    ['Thai', 'รถ 2 คัน'],
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
