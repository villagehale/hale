import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The flag-off sign-in classes (auth-google, auth-field, auth-submit, auth-or)
 * left with the magic-link form. A leftover class in the stylesheet or on
 * /sign-in would be a door that no longer has a definition, or a definition
 * with no door.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const RETIRED = ['auth-google', 'auth-submit', 'auth-field', 'auth-or', 'auth-submit-ring'];

describe('retired email-auth classes', () => {
  it('are gone from the sign-in door, the shell, and the stylesheet', () => {
    const sources = [
      read('../../app/sign-in/page.tsx'),
      read('./auth-shell.tsx'),
      read('../../app/globals.css'),
      read('./connect/connect.module.css'),
    ];
    for (const cls of RETIRED) {
      for (const source of sources) {
        expect(source).not.toContain(cls);
      }
    }
  });
});
