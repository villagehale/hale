#!/usr/bin/env node
/**
 * Gates the second source of truth: src/constants/meadow.ts mirrors a few hex
 * tokens from src/global.css for APIs that need a literal color (SF Symbol
 * tints). This asserts they stay in sync — drift exits non-zero (CI gate).
 *
 * Only the tokens meadow.ts actually mirrors are checked. Adding a key to
 * meadow.ts that isn't in global.css, or a mismatched hex, fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../src/global.css');
const meadowPath = resolve(here, '../src/constants/meadow.ts');

const css = readFileSync(cssPath, 'utf8');
const meadow = readFileSync(meadowPath, 'utf8');

// meadow.ts key -> global.css CSS var name
const TOKEN_MAP = {
  ink: '--color-ink',
  ink2: '--color-ink-2',
  ink3: '--color-ink-3',
  canvas: '--color-canvas',
  accentFill: '--color-accent-fill',
};

/** Pull the light (:root) and dark (@media prefers-color-scheme: dark) blocks. */
function cssBlocks(source) {
  const darkStart = source.indexOf('prefers-color-scheme: dark');
  if (darkStart === -1) throw new Error('dark-mode block not found in global.css');
  return { light: source.slice(0, darkStart), dark: source.slice(darkStart) };
}

function cssVar(block, name) {
  const m = block.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  return m ? m[1].toLowerCase() : null;
}

/** Pull a scheme object's hex values from meadow.ts (light: {...}, dark: {...}). */
function meadowScheme(source, scheme) {
  const start = source.indexOf(`${scheme}: {`);
  if (start === -1) throw new Error(`meadow.ts ${scheme} block not found`);
  const block = source.slice(start, source.indexOf('}', start));
  const out = {};
  for (const key of Object.keys(TOKEN_MAP)) {
    const m = block.match(new RegExp(`${key}\\s*:\\s*'(#[0-9a-fA-F]{6})'`));
    out[key] = m ? m[1].toLowerCase() : null;
  }
  return out;
}

const blocks = cssBlocks(css);
const errors = [];

for (const scheme of ['light', 'dark']) {
  const meadowVals = meadowScheme(meadow, scheme);
  for (const [key, cssName] of Object.entries(TOKEN_MAP)) {
    const cssHex = cssVar(blocks[scheme], cssName);
    const meadowHex = meadowVals[key];
    if (!cssHex) errors.push(`global.css ${scheme}: ${cssName} not found`);
    if (!meadowHex) errors.push(`meadow.ts ${scheme}.${key} not found`);
    if (cssHex && meadowHex && cssHex !== meadowHex) {
      errors.push(`${scheme}.${key}: meadow.ts ${meadowHex} ≠ global.css ${cssName} ${cssHex}`);
    }
  }
}

if (errors.length) {
  console.error('Token drift detected (meadow.ts vs global.css):');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('Token map in sync (meadow.ts ↔ global.css), light + dark.');
