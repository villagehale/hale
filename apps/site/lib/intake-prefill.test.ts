import { describe, expect, it } from 'vitest';
import { intakePrefill } from './intake-prefill.js';
import { INTAKE_PREFILL } from './text-entry.js';

/**
 * The composer body is existing copy. EN is the locked constant. FR is
 * Text.sentGloss, already on the /text page. ZH has no locked line to send,
 * so it keeps the English hello and the page glosses it.
 */

const FR_HELLO = 'Salut Hale, qu\u2019est-ce qui se passe ?';

describe('intakePrefill', () => {
  it('is the locked English hello, and the French page reuses sentGloss exactly', () => {
    expect(intakePrefill('en')).toBe(INTAKE_PREFILL);
    expect(intakePrefill('en')).toBe("Hey Hale, what's going on?");
    expect(intakePrefill('fr')).toBe(FR_HELLO);
    expect(intakePrefill('fr')).not.toBe(INTAKE_PREFILL);
  });

  it('keeps Chinese on the English hello — there is no locked Chinese line to send', () => {
    expect(intakePrefill('zh')).toBe(INTAKE_PREFILL);
  });
});
