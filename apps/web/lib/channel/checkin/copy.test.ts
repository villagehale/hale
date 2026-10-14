import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_ACK_TEMPLATE_KEY,
  CHECK_IN_ASK_TEMPLATE_KEY,
  CHECK_IN_STEP_DOWN_TEMPLATE_KEY,
  GENERIC_CHILD_PHRASE,
  childPhrase,
} from './copy';

describe('the evening check-in has no fixed lines', () => {
  it('keeps the ledger names and the child phrase travel borrows', () => {
    expect(CHECK_IN_ASK_TEMPLATE_KEY).toBe('checkin:ask');
    expect(CHECK_IN_STEP_DOWN_TEMPLATE_KEY).toBe('checkin:weekly');
    expect(CHECK_IN_ACK_TEMPLATE_KEY).toBe('checkin:ack');
    expect(childPhrase([])).toBe(GENERIC_CHILD_PHRASE);
    expect(childPhrase(['Mia'])).toBe('Mia');
    expect(childPhrase(['Mia', 'Leo'])).toBe('Mia and Leo');
    expect(childPhrase(['娜'])).toBe(GENERIC_CHILD_PHRASE);
  });

  it('stores no sentence a parent could be told to answer with a keyword', () => {
    const source = readFileSync(fileURLToPath(new URL('./copy.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\b(?:reply|text|send)\s+[A-Z]{2,}\b/);
    expect(source).not.toContain('DAILY');
    expect(source).not.toContain('LESS');
  });
});
