// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANALYTICS_OPT_OUT_COOKIE,
  ANALYTICS_OPT_OUT_QUERY,
  ANALYTICS_OPT_OUT_QUERY_VALUE,
  ANALYTICS_OPT_OUT_STORAGE_KEY,
  hasAnalyticsOptOut,
} from './opt-out';

afterEach(() => {
  window.localStorage.clear();
  document.cookie = `${ANALYTICS_OPT_OUT_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  window.history.replaceState(null, '', '/sign-in');
});

describe('analytics opt-out', () => {
  it('is off by default', () => {
    expect(hasAnalyticsOptOut()).toBe(false);
  });

  it('honours a first-party cookie without a privacy-page UI', () => {
    document.cookie = `${ANALYTICS_OPT_OUT_COOKIE}=1; path=/`;
    expect(hasAnalyticsOptOut()).toBe(true);
  });

  it('honours localStorage', () => {
    window.localStorage.setItem(ANALYTICS_OPT_OUT_STORAGE_KEY, '1');
    expect(hasAnalyticsOptOut()).toBe(true);
  });

  it('latches ?analytics=off into cookie and storage so a later visit stays off', () => {
    window.history.replaceState(
      null,
      '',
      `/sign-in?${ANALYTICS_OPT_OUT_QUERY}=${ANALYTICS_OPT_OUT_QUERY_VALUE}`,
    );
    expect(hasAnalyticsOptOut()).toBe(true);
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY)).toBe('1');
    expect(document.cookie).toContain(`${ANALYTICS_OPT_OUT_COOKIE}=1`);
  });
});
