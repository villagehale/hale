import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIGNUP_OFFER_SENTENCE_TODO } from './offer-copy';

const DIR = fileURLToPath(new URL('.', import.meta.url));

describe('signup offer sentence', () => {
  it('is a TODO-Design placeholder and is never placed on a send path', () => {
    expect(SIGNUP_OFFER_SENTENCE_TODO.startsWith('TODO-Design:')).toBe(true);
    const files = readdirSync(DIR).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'offer-copy.ts',
    );
    expect(files).toContain('run.ts');
    expect(files).toContain('copy.ts');
    for (const name of files) {
      const source = readFileSync(`${DIR}${name}`, 'utf8');
      expect(source, name).not.toContain('TODO-Design');
      expect(source, name).not.toContain(SIGNUP_OFFER_SENTENCE_TODO);
    }
  });
});
