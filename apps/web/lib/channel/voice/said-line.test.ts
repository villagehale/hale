import { describe, expect, it } from 'vitest';
import { type SaidLineInput, acceptSaidLine } from './said-line';

const health: SaidLineInput = {
  purpose: 'health',
  language: 'en',
  parentWords: 'my son fell and his wrist is swollen',
  facts: { healthLine: 'Health811 (Ontario), call 811, any time', emergency: '911' },
  mustInclude: ['811', '911'],
};

describe('said-line · code checks the facts, the model writes the words', () => {
  it('accepts any wording that carries both numbers', () => {
    const text =
      'I can’t advise on that. Health811 is there any time at 811, and for an emergency call 911.';
    expect(acceptSaidLine(text, health)).toBe(text);
  });

  it('refuses a health line missing a number', () => {
    expect(acceptSaidLine('Call 811 any time.', health)).toBeNull();
  });

  it('refuses an empty write', () => {
    expect(acceptSaidLine('   ', health)).toBeNull();
  });

  it('fills link slots with the exact URL and refuses any URL the model typed', () => {
    const url = 'https://hale.example/connect?t=a';
    const links: SaidLineInput = {
      purpose: 'connector_link',
      language: null,
      facts: { link: '[[link]]', minutesValid: 15 },
      links: { link: url },
    };
    expect(acceptSaidLine('Tap to connect:\n[[link]]\nGood for 15 minutes.', links)).toBe(
      `Tap to connect:\n${url}\nGood for 15 minutes.`,
    );
    // Retyped (even correctly), missing, doubled, or an unknown slot: refused.
    expect(acceptSaidLine(`Tap: ${url}`, links)).toBeNull();
    expect(acceptSaidLine('Tap to connect.', links)).toBeNull();
    expect(acceptSaidLine('[[link]] and [[link]]', links)).toBeNull();
    expect(acceptSaidLine('[[link]] [[other]]', links)).toBeNull();
  });
});

describe('#919: mustConvey keys are structural; meaning is the convey judge', () => {
  const off: SaidLineInput = {
    purpose: 'intro_reply',
    language: null,
    parentWords: '紹介はもういらないです',
    facts: { situation: 'off', pendingClosed: 'any pending are closed' },
    mustConvey: ['pendingClosed'],
  };
  it('does not word-match: a text passes acceptSaidLine when every key names a fact', () => {
    // The meaning gate is the writer (VIL-530). This check stays key-only so a
    // word list cannot grow up in its place.
    expect(acceptSaidLine('わかりました。', off)).toBe('わかりました。');
  });
  it('refuses a mustConvey key with no fact behind it', () => {
    expect(acceptSaidLine('ok', { ...off, mustConvey: ['missing'] })).toBeNull();
  });
});

describe('VIL-608: a write whose UTF-8 came back read through a single-byte code page is put back', () => {
  const softClose: SaidLineInput = {
    purpose: 'intro_reply',
    language: null,
    facts: { situation: 'the introduction Hale asked them about is not happening' },
  };
  // Verbatim from the writer on the Spanish soft close, one per code page it came back in.
  it.each([
    [
      'Esa presentaciĂłn no va a ocurrir. Las demĂĄs siguen en pie, y cuando Hale encuentre una buena opciĂłn para ti, te escribirĂĄ para contĂĄrtelo.',
      'Esa presentación no va a ocurrir. Las demás siguen en pie, y cuando Hale encuentre una buena opción para ti, te escribirá para contártelo.',
    ],
    [
      'La presentaciΓ³n de la que te hablΓ© no va a suceder. Las otras presentaciones siguen en pie, y cuando Hale encuentre una buena opciΓ³n para ti, te escribe por aquΓ­.',
      'La presentación de la que te hablé no va a suceder. Las otras presentaciones siguen en pie, y cuando Hale encuentre una buena opción para ti, te escribe por aquí.',
    ],
    [
      'Esa presentaciأ³n que te comentأ© no se va a dar. Las otras siguen en pie para ti, y cuando Hale encuentre una buena opciأ³n para ti, te escribe por aquأ­.',
      'Esa presentación que te comenté no se va a dar. Las otras siguen en pie para ti, y cuando Hale encuentre una buena opción para ti, te escribe por aquí.',
    ],
    [
      'Esa presentaciĆ³n no va a seguir adelante. Las demĆ”s presentaciones siguen en pie para ti, y cuando Hale encuentre una buena opciĆ³n para ti, te escribe.',
      'Esa presentación no va a seguir adelante. Las demás presentaciones siguen en pie para ti, y cuando Hale encuentre una buena opción para ti, te escribe.',
    ],
  ])('%s', (garbled, meant) => {
    expect(acceptSaidLine(garbled, softClose)).toBe(meant);
  });

  it.each([
    'Esa presentación no va a ocurrir. Las demás siguen en pie.',
    "Je suis Hale, un assistant IA. Si tu veux que j'arrête, dis-le-moi : c’est noté.",
    'فهمت، لن يحدث هذا التعارف. ما زالت التعارفات الأخرى متاحة لك.',
    '好的，谢谢你！这次介绍不会进行了。',
    'Got it 👍 nothing changed.',
  ])('leaves a correctly encoded write as it is: %s', (text) => {
    expect(acceptSaidLine(text, softClose)).toBe(text);
  });
});
