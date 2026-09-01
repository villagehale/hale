import { describe, expect, it } from 'vitest';
import { ADMIN_TABS, isActiveTab, tabHref } from './admin-tabs';

/**
 * The tab bar's URL contract: seven real routes, every href carrying the
 * dial's `?w=` forward, and Overview active on exact match only (it prefixes
 * every other tab).
 */
describe('ADMIN_TABS', () => {
  it('is the seven questions, Overview first', () => {
    expect(ADMIN_TABS.map((t) => t.href)).toEqual([
      '/admin',
      '/admin/engagement',
      '/admin/funnels',
      '/admin/operations',
      '/admin/agents',
      '/admin/radar',
      '/admin/ledger',
    ]);
  });
});

describe('tabHref — the dial survives tab navigation', () => {
  it('carries the current ?w= onto every tab href', () => {
    expect(tabHref('/admin/operations', '365')).toBe('/admin/operations?w=365');
    expect(tabHref('/admin', '90')).toBe('/admin?w=90');
  });

  it('emits a bare href when no window param is set (default dial)', () => {
    expect(tabHref('/admin/agents', null)).toBe('/admin/agents');
  });
});

describe('isActiveTab', () => {
  it('marks Overview active on /admin exactly, never on sub-tabs', () => {
    expect(isActiveTab('/admin', '/admin')).toBe(true);
    expect(isActiveTab('/admin', '/admin/operations')).toBe(false);
  });

  it('marks a sub-tab active on itself and its own children only', () => {
    expect(isActiveTab('/admin/operations', '/admin/operations')).toBe(true);
    expect(isActiveTab('/admin/operations', '/admin/agents')).toBe(false);
    expect(isActiveTab('/admin/operations', '/admin')).toBe(false);
  });
});
