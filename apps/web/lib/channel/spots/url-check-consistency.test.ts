import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REGISTRATION_COURSE_URL_MAX_CHARS } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { MAX_URL_CHARS } from './url';

const ROOT = path.resolve(__dirname, '../../../../..');
const DRIZZLE = path.join(ROOT, 'packages/db/drizzle');

/** The DB bound on registration_sequences.course_url started as the app's MAX_URL_CHARS
 * (the PerfectMind SMS bound) and was widened to REGISTRATION_COURSE_URL_MAX_CHARS once a
 * watch could hold any public course link. Each number is written twice; this keeps each
 * pair the same number. */
describe('course_url length bound', () => {
  it('0111 bounds course_url at the spots MAX_URL_CHARS', () => {
    const source = readFileSync(
      path.join(DRIZZLE, '0111_registration_sequence_course_url_length.sql'),
      'utf8',
    );
    expect(source).toMatch(new RegExp(`length\\("course_url"\\) <= ${MAX_URL_CHARS}\\b`));
  });

  it('the watch-storage migration bounds course_url at REGISTRATION_COURSE_URL_MAX_CHARS', () => {
    const file = readdirSync(DRIZZLE).find((f) =>
      f.endsWith('_registration_live_watch_storage.sql'),
    );
    expect(file).toMatch(/^\d{4}_registration_live_watch_storage\.sql$/);
    const source = readFileSync(path.join(DRIZZLE, file as string), 'utf8');
    expect(source).toContain(
      `length("course_url") BETWEEN 1 AND ${REGISTRATION_COURSE_URL_MAX_CHARS}`,
    );
  });
});
