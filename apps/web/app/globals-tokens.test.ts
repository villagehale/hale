import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * WEB-TOKENS gate — the Hale Shore ↔ legacy token mirror (VIL-209 W1).
 *
 * apps/web predates the shared design-system vocabulary, so each Shore role that
 * already existed here under a legacy name now carries BOTH names. New code writes
 * the Shore name; the legacy name is deleted surface-by-surface across the later
 * phases of this arc. While both exist they MUST resolve to the same colour — if
 * they drift, half the app silently renders a different value from the other half,
 * and neither reviewer nor screenshot would show which half is wrong.
 *
 * A CSS alias (`--color-linen: var(--color-canvas)`) cannot express this, because a
 * custom property is substituted at computed-value time: `.dark .sidebar` re-points
 * `--color-canvas` for its subtree, and an aliased `--color-linen` inherited from
 * `:root` would NOT follow it. So both names are declared literally, in every scope
 * that re-points either — and this test is what keeps them equal.
 */

const MIRRORS: ReadonlyArray<readonly [shore: string, legacy: string]> = [
  ['--color-canvas', '--color-linen'],
  ['--color-card', '--color-oat'],
  ['--color-ink', '--color-spruce'],
  ['--color-ink-2', '--color-slate-green'],
  ['--color-ink-3', '--color-faded-sage'],
  ['--color-caption', '--color-muted'],
  ['--color-on-ink', '--color-on-spruce'],
  ['--color-destructive', '--color-berry'],
  ['--color-cream-accent', '--color-amber'],
];

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
const root = postcss.parse(CSS);

/** Every scope (`@theme`, `.dark`, `.dark .sidebar`, …) that declares custom
 * properties, as scopeName → { prop: value }. A selector may appear more than once
 * (`.dark` is declared in two places), so scopes accumulate rather than replace —
 * merging them is what the cascade does, and it is what must stay consistent. */
function declarationScopes(): Map<string, Map<string, string>> {
  const scopes = new Map<string, Map<string, string>>();
  const record = (scope: string, node: postcss.Container) => {
    const props = scopes.get(scope) ?? new Map<string, string>();
    node.each((child) => {
      if (child.type === 'decl' && child.prop.startsWith('--')) {
        props.set(child.prop, child.value.trim().toLowerCase());
      }
    });
    if (props.size > 0) scopes.set(scope, props);
  };
  root.walkAtRules('theme', (at) => record('@theme', at));
  root.walkRules((rule) => record(rule.selector.replace(/\s+/g, ' ').trim(), rule));
  return scopes;
}

/** The two `themeColor` hexes the root layout hands the browser chrome, keyed by
 * scheme — read out of the source because Next needs them as static literals. */
function layoutThemeColors(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of source.matchAll(
    /prefers-color-scheme:\s*(light|dark)\)',\s*color:\s*'(#[0-9a-fA-F]{6})'/g,
  )) {
    const [, scheme, hex] = m;
    if (scheme && hex) found[scheme] = hex.toLowerCase();
  }
  return found;
}

const SCOPES = declarationScopes();

describe('globals.css — Hale Shore ↔ legacy token mirror (VIL-209)', () => {
  it('declares every mirrored pair in the base scope', () => {
    const base = SCOPES.get('@theme');
    const missing = MIRRORS.flatMap(([shore, legacy]) =>
      [shore, legacy].filter((prop) => !base?.has(prop)),
    );
    expect(missing).toEqual([]);
  });

  it('gives both halves of a pair the same value in every scope that declares either', () => {
    const drift: string[] = [];
    for (const [scope, props] of SCOPES) {
      for (const [shore, legacy] of MIRRORS) {
        const a = props.get(shore);
        const b = props.get(legacy);
        if (a === undefined && b === undefined) continue;
        if (a !== b) drift.push(`${scope}: ${shore}=${a ?? '(absent)'} ${legacy}=${b ?? '(absent)'}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('pins the identity tokens to the Hale Shore values in apps/mobile/src/global.css', () => {
    const base = SCOPES.get('@theme');
    expect(base?.get('--color-canvas')).toBe('#fdfcfa');
    expect(base?.get('--color-card')).toBe('#ffffff');
    expect(base?.get('--color-brand')).toBe('#1b2160');
    expect(base?.get('--color-ink')).toBe('#17294a');
    expect(base?.get('--color-ink-3')).toBe('#5c6b87');
    expect(base?.get('--color-caption')).toBe('#8b95a9');
    expect(base?.get('--color-accent')).toBe('#c2410c');
    expect(base?.get('--color-cream')).toBe('#fff6e9');
    expect(base?.get('--color-chip-blue')).toBe('#edf0fa');
  });

  it('keeps the app canvas and the browser-chrome theme-color in step', () => {
    const layout = readFileSync(fileURLToPath(new URL('./layout.tsx', import.meta.url)), 'utf8');
    expect(layoutThemeColors(layout)).toEqual({
      light: SCOPES.get('@theme')?.get('--color-canvas'),
      dark: SCOPES.get('.dark')?.get('--color-canvas'),
    });
  });
});
