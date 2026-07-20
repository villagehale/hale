import { describe, expect, it } from 'vitest';
import { COMPANION_TABS, tabFromParam } from './companion-tabs-nav.js';

describe('Companion sub-tab taxonomy (§4.3)', () => {
  it('is the six §4.3 tabs in display order', () => {
    expect(COMPANION_TABS.map((t) => t.key)).toEqual([
      'overview',
      'health',
      'growth',
      'milestones',
      'routines',
      'documents',
    ]);
  });
});

describe('tabFromParam', () => {
  it('accepts a known tab key', () => {
    expect(tabFromParam('growth')).toBe('growth');
    expect(tabFromParam('milestones')).toBe('milestones');
    expect(tabFromParam('documents')).toBe('documents');
  });

  it('falls back to overview for a missing or unknown value', () => {
    expect(tabFromParam(undefined)).toBe('overview');
    expect(tabFromParam('moments')).toBe('overview');
    expect(tabFromParam('')).toBe('overview');
  });

  it('takes the first when the param repeats', () => {
    expect(tabFromParam(['health', 'growth'])).toBe('health');
  });
});
