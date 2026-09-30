import { describe, expect, it } from 'vitest';
import { intakePrefill } from './intake-prefill.js';
import { INTAKE_PREFILL, INTAKE_PREFILL_FR } from './text-entry.js';

/**
 * The composer body is locked copy. EN is INTAKE_PREFILL. FR is
 * INTAKE_PREFILL_FR (ASCII apostrophe, no space before ?). ZH has no locked
 * line to send, so it keeps the English hello and the page glosses it.
 */

describe('intakePrefill', () => {
  it('is the locked English hello, and French is Sloane’s exact line', () => {
    expect(intakePrefill('en')).toBe(INTAKE_PREFILL);
    expect(intakePrefill('en')).toBe("Hey Hale, what's going on?");
    expect(INTAKE_PREFILL_FR).toBe("Salut Hale, qu'est-ce qui se passe?");
    expect(intakePrefill('fr')).toBe(INTAKE_PREFILL_FR);
    expect(intakePrefill('fr')).not.toContain('\u2019');
    expect(intakePrefill('fr')).not.toContain(' ?');
    expect(intakePrefill('fr')).not.toBe(INTAKE_PREFILL);
  });

  it('keeps Chinese on the English hello — there is no locked Chinese line to send', () => {
    expect(intakePrefill('zh')).toBe(INTAKE_PREFILL);
  });
});
