import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_URL_CHARS } from './url';

const ROOT = path.resolve(__dirname, '../../../../..');

/** The DB bound on registration_sequences.course_url and the app's MAX_URL_CHARS are the
 * same number written twice; this is what keeps them the same number. */
describe('course_url length bound', () => {
  it.each([
    'packages/db/drizzle/0111_registration_sequence_course_url_length.sql',
    'packages/db/src/schema/registration-sequences.ts',
  ])('%s bounds course_url at MAX_URL_CHARS', (file) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    expect(source).toMatch(new RegExp(`length\\((?:"course_url"|\\$\\{table\\.courseUrl\\})\\) <= ${MAX_URL_CHARS}\\b`));
  });
});
