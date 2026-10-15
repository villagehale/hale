import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REGISTRATION_COURSE_URL_MAX_CHARS } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { MAX_URL_CHARS } from './url';

const ROOT = path.resolve(__dirname, '../../../../..');

/** Spot links still use the original 200-char bound; registration watches now accept
 * other public course URLs without widening the spot allowlist or its copy budget. */
describe('course_url length bound', () => {
  it('keeps the historical spot-only bound', () => {
    const source = readFileSync(
      path.join(ROOT, 'packages/db/drizzle/0111_registration_sequence_course_url_length.sql'),
      'utf8',
    );
    expect(source).toMatch(new RegExp(`length\\("course_url"\\) <= ${MAX_URL_CHARS}\\b`));
  });
  it('keeps the new migration and storage bound aligned', () => {
    const source = readFileSync(
      path.join(ROOT, 'packages/db/drizzle/0172_registration_live_watch_storage.sql'),
      'utf8',
    );
    expect(source).toContain(
      `length("course_url") BETWEEN 1 AND ${REGISTRATION_COURSE_URL_MAX_CHARS}`,
    );
  });
});
