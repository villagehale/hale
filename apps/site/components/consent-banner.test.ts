import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../app/consent.css', import.meta.url)), 'utf8');
const banner = readFileSync(
  fileURLToPath(new URL('./consent-banner.tsx', import.meta.url)),
  'utf8',
);

describe('consent banner glass', () => {
  it('keeps the floating card measurements and the solid fallbacks', () => {
    expect(css).toContain('width: 440px');
    expect(css).toContain('left: 24px');
    expect(css).toContain('border-radius: 20px');
    expect(css).toContain('border-radius: 22px');
    expect(css).toContain('height: 44px');
    expect(css).toContain('min-width: 112px');
    expect(css).toContain('backdrop-filter: var(--cb-blur)');
    expect(css).toContain('blur(24px) saturate(1.8)');
    expect(css).toContain('blur(24px) saturate(1.6)');
    expect(css).toContain('prefers-reduced-transparency: reduce');
    expect(css).toContain('prefers-reduced-motion: no-preference');
    expect(css).toContain('translateY(12px)');
    expect(css).toMatch(/\.consent-inline a \{[^}]*text-decoration: underline/);
    expect(css).not.toContain('is-dark');
    expect(css).not.toContain('is-equal');
  });

  it('wraps the Chinese trailing clause and still clears the click cookie on No thanks', () => {
    expect(banner).toContain('什么都不会加载。');
    expect(banner).toContain('consent-nowrap');
    expect(banner).toContain('clearGoogleClickCookies');
    expect(banner).not.toContain('URLSearchParams');
  });
});
