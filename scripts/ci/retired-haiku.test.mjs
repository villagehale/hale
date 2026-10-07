import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchingLines, retiredHaikuFamily, retiredHaikuHits } from './retired-haiku.mjs';

describe('retired Haiku 3.5 alias', () => {
  it('recognises the bare id, the latest alias, and the dated snapshot', () => {
    const family = retiredHaikuFamily();
    const dated = `${family}-${['2024', '1022'].join('')}`;
    const sample = [
      `model: ${family}`,
      `model: ${family}-latest`,
      `model: ${dated}`,
      'model: claude-haiku-4-5',
    ].join('\n');

    expect(matchingLines(sample)).toEqual([
      `1:model: ${family}`,
      `2:model: ${family}-latest`,
      `3:model: ${dated}`,
    ]);
  });

  it('does not embed the retired id in the guard itself', () => {
    const here = fileURLToPath(new URL('./retired-haiku.mjs', import.meta.url));
    const test = fileURLToPath(import.meta.url);
    const family = retiredHaikuFamily();
    expect(readFileSync(here, 'utf8').includes(family)).toBe(false);
    expect(readFileSync(test, 'utf8').includes(family)).toBe(false);
  });

  it('is absent from every tracked file', () => {
    const hits = retiredHaikuHits();
    expect(
      hits,
      `Retired Haiku 3.5 is still named. Use HAIKU_MODEL from packages/agent/src/model.ts (claude-haiku-4-5).\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});
