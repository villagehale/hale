import { describe, expect, it } from 'vitest';
import { hasGarbledText } from './garbled-text';

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
    ['French', "Rien n'a été débité : l’été, « créée », Noël, naïve, Œuvre, ça, où, déjà."],
    ['Spanish', '¿Sábado o domingo? Ya están en la lista, mamá.'],
    ['German', 'Schwimmkurs für Ada, Größe egal.'],
    ['Chinese', 'Ada 的 Preschool Swim 周日 10:00 还没有确认报名成功。'],
    ['punctuation', 'Sun 10:00 — $98… “ok”'],
    // "รถ" reads back as UTF-8 "ö": a Thai word, not a broken letter inside a Latin one.
    ['Thai', 'รถ 2 คัน'],
  ])('sends %s', (_name, text) => {
    expect(hasGarbledText(text)).toBe(false);
  });
});
