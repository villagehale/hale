import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_EXPORT_ROUND_2_ENABLED_ENV,
  accessExportBlurb,
  accessExportRound2Enabled,
} from './export-round-2';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('accessExportRound2Enabled', () => {
  it('is on for exactly the literal "true"', () => {
    vi.stubEnv(ACCESS_EXPORT_ROUND_2_ENABLED_ENV, 'true');
    expect(accessExportRound2Enabled()).toBe(true);
  });

  it('fails closed on the trailing newline a piped echo stores', () => {
    vi.stubEnv(ACCESS_EXPORT_ROUND_2_ENABLED_ENV, 'true\n');
    expect(accessExportRound2Enabled()).toBe(false);
  });

  it('fails closed on every other truthy-looking spelling', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', ' true', 'true ']) {
      vi.stubEnv(ACCESS_EXPORT_ROUND_2_ENABLED_ENV, value);
      expect(accessExportRound2Enabled(), value).toBe(false);
    }
  });

  it('is off when unset', () => {
    vi.stubEnv(ACCESS_EXPORT_ROUND_2_ENABLED_ENV, '');
    expect(accessExportRound2Enabled()).toBe(false);
  });
});

describe('accessExportBlurb', () => {
  it('keeps the unlit line', () => {
    expect(accessExportBlurb({})).toBe('A copy of everything Hale holds.');
  });

  it('says removed lines are included when lit', () => {
    expect(accessExportBlurb({ [ACCESS_EXPORT_ROUND_2_ENABLED_ENV]: 'true' })).toBe(
      'A copy of everything Hale holds, including lines you removed.',
    );
  });
});
