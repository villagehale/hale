import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * VIL-302 / VIL-413. A reply is placed by the model. The shared yes/no table is gone.
 * Carrier STOP, HELP, and START stay on the opt-out reader.
 */
describe('natural replies are not a word list', () => {
  it('no longer ships the shared affirmative table', () => {
    expect(() => readFileSync(new URL('./affirmative.ts', import.meta.url), 'utf8')).toThrow();
  });

  it('does not ask a parent to reply with a number', () => {
    const copy = readFileSync(new URL('./router/copy.ts', import.meta.url), 'utf8');
    expect(copy).not.toMatch(/Reply \$\{orJoinNumbers/);
    expect(copy).not.toContain('or just say which');
  });
});
