import { describe, expect, it } from 'vitest';
import {
  isThemePreference,
  readStoredPreference,
  resolveTheme,
  THEME_STORAGE_KEY,
} from './theme.js';

describe('resolveTheme', () => {
  it('passes explicit light/dark through regardless of the OS setting', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('follows the OS setting when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('readStoredPreference', () => {
  it('returns the stored value when it is a valid preference', () => {
    expect(readStoredPreference('light')).toBe('light');
    expect(readStoredPreference('dark')).toBe('dark');
    expect(readStoredPreference('system')).toBe('system');
  });

  it('falls back to system for a missing or corrupt value', () => {
    expect(readStoredPreference(null)).toBe('system');
    expect(readStoredPreference('')).toBe('system');
    expect(readStoredPreference('DARK')).toBe('system');
    expect(readStoredPreference('auto')).toBe('system');
  });
});

describe('isThemePreference', () => {
  it('accepts only the three preference literals', () => {
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('blue')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
    expect(isThemePreference(0)).toBe(false);
  });
});

describe('THEME_STORAGE_KEY', () => {
  it('is the namespaced localStorage key the toggle and pre-paint script share', () => {
    expect(THEME_STORAGE_KEY).toBe('hale-theme');
  });
});
