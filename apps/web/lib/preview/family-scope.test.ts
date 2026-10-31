import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_CRON_POLICY,
  familyInPreviewScope,
  previewCronSkipReason,
  previewTestFamilyIds,
  scopeFamilies,
} from './family-scope';

const TEST_FAM = '11111111-1111-4111-8111-111111111111';
const REAL_FAM = '22222222-2222-4222-8222-222222222222';
const PREVIEW = {
  VERCEL_ENV: 'preview',
  PREVIEW_FAMILY_ALLOWLIST: ` ${TEST_FAM} , not-a-uuid`,
  PREVIEW_CAPTURE_TRANSPORT: 'on',
};

describe('preview family scope', () => {
  it('parses the allowlist and ignores junk', () => {
    expect([...previewTestFamilyIds(PREVIEW)]).toEqual([TEST_FAM]);
  });

  it('regression: a non-test family is skipped on preview', () => {
    expect(familyInPreviewScope(REAL_FAM, PREVIEW)).toBe(false);
    expect(familyInPreviewScope(TEST_FAM, PREVIEW)).toBe(true);
    const rows = [{ familyId: REAL_FAM }, { familyId: TEST_FAM }];
    expect(scopeFamilies(rows, PREVIEW)).toEqual([{ familyId: TEST_FAM }]);
  });

  it('is a no-op in production and locally', () => {
    const rows = [{ familyId: REAL_FAM }];
    for (const env of [{ VERCEL_ENV: 'production' }, {}]) {
      expect(familyInPreviewScope(REAL_FAM, env)).toBe(true);
      expect(scopeFamilies(rows, env)).toEqual(rows);
      expect(previewCronSkipReason('drain', env)).toBeNull();
      expect(previewCronSkipReason('anything-new', env)).toBeNull();
    }
  });

  it('fails closed on preview', () => {
    expect(previewCronSkipReason('drain', PREVIEW)).toBe('preview_cron_not_scoped');
    expect(previewCronSkipReason('unlisted', PREVIEW)).toBe('preview_cron_not_scoped');
    expect(previewCronSkipReason('reminders', { VERCEL_ENV: 'preview' })).toBe(
      'preview_no_test_families',
    );
    expect(previewCronSkipReason('reminders', { ...PREVIEW, PREVIEW_CAPTURE_TRANSPORT: '' })).toBe(
      'preview_capture_off',
    );
    expect(previewCronSkipReason('reminders', PREVIEW)).toBeNull();
    expect(previewCronSkipReason('registration-sequence', PREVIEW)).toBeNull();
  });

  it('every cron in vercel.json has a preview policy', () => {
    const config = JSON.parse(readFileSync(join(__dirname, '../../vercel.json'), 'utf8')) as {
      crons: { path: string }[];
    };
    for (const { path } of config.crons) {
      const slug = path.replace('/api/cron/', '');
      expect(PREVIEW_CRON_POLICY[slug], slug).toBeDefined();
    }
  });
});
