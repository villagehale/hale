import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthShell } from './auth-shell';

/**
 * The auth door is the sign-in shore: ConnectStage plus the glass card. These
 * assert the load-bearing decisions — the shore art, the page heading and form
 * in the card, the sign-in footer — and that the retired side panel is gone.
 */

const html = renderToStaticMarkup(
  createElement(
    AuthShell,
    { heading: 'Welcome back', subtitle: 'Sign in to your village.' },
    createElement('form', null, 'FORM_SLOT'),
  ),
);

const PANEL = ['every parent needs', 'calm AI co-pilot', 'For your neighborhood'] as const;

describe('AuthShell — the sign-in shore door', () => {
  it('uses the sign-in shore and puts the form in the card', () => {
    expect(html).toContain('/connect/hale-shore-hero.webp');
    expect(html).toContain('FORM_SLOT');
    expect(html).not.toContain('auth-stage');
    expect(html).not.toContain('auth-backdrop');
    expect(html).not.toContain('village-illustration');
  });

  it('renders the page heading as the document h1 and the subtitle beneath it', () => {
    expect(html).toMatch(/<h1[^>]*>Welcome back<\/h1>/);
    expect(html).toContain('Sign in to your village.');
  });

  it('carries the sign-in footer and not the retired panel', () => {
    expect(html).toContain('Never sold.');
    expect(html).toContain('Privacy policy');
    expect(html).toContain('https://www.villagehale.com/privacy');
    expect(html).toContain('/HAH-leh/');
    expect(html).toContain('Hawaiian for home');
    for (const line of PANEL) expect(html).not.toContain(line);
    expect(html).not.toContain('stays in Canada');
    expect(html).not.toContain('Nothing is shared until you say so');
  });

  it('adds no theme script of its own', () => {
    expect(html).not.toContain('hale-theme');
    expect(html).not.toContain('matchMedia');
    expect(html).not.toContain('<script');
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(tsx|css)$/.test(name) || name.includes('.test.')) continue;
    out.push(path);
  }
  return out;
}

describe('the retired auth side panel', () => {
  it('is gone from the web app', () => {
    const web = fileURLToPath(new URL('../..', import.meta.url));
    const hits: string[] = [];
    for (const file of sourceFiles(web)) {
      const source = readFileSync(file, 'utf8');
      for (const line of PANEL) {
        if (source.includes(line)) hits.push(`${file}: ${line}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
