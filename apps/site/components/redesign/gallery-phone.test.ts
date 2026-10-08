import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { lastVisibleBottom, threadPinDelta } from './phone-chat';

const css = readFileSync(fileURLToPath(new URL('../../app/redesign.css', import.meta.url)), 'utf8');

it('sizes the gallery handset from the viewport at iPhone proportions, with no fixed height', () => {
  expect(css).toContain('aspect-ratio: 71.5 / 146.6');
  expect(css).toContain('min(78vw, 320px, calc((100svh - 240px) / 2.05))');
  expect(css).not.toContain('height: min(560px, calc(100svh - var(--nav-h) - 140px))');
  expect(css).not.toContain('aspect-ratio: auto');
  const rule = css.match(/\.rd \.gallery-phone \{[\s\S]*?\n\}/)?.[0] ?? '';
  expect(rule).toContain('aspect-ratio: 71.5 / 146.6');
  expect(rule).toContain('min-height: 0');
  expect(rule).not.toMatch(/(^|\s)height:/);
});

it('lets the gallery thread scroll from the bottom so the last line is not clipped', () => {
  const rule = css.match(/\.rd \.gallery-phone \.hs-thread \{[^}]*\}/)?.[0] ?? '';
  expect(rule).toContain('min-height: 0');
  expect(rule).toContain('overflow-y: auto');
  expect(rule).not.toContain('justify-content');
  expect(css).toContain('.rd .gallery-phone .hs-thread::before {');
  expect(css).toContain('flex: 1 0 0;');
  expect(css).toContain(
    '.rd .hs-chats { margin-top: var(--s7); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));',
  );
});

it('follows the latest visible line and leaves a finished thread on the padding edge', () => {
  expect(
    lastVisibleBottom([
      { opacity: 1, bottom: 100 },
      { opacity: 0, bottom: 180 },
      { opacity: 1, bottom: 140 },
    ]),
  ).toBe(140);
  expect(lastVisibleBottom([{ opacity: 0, bottom: 80 }])).toBeNull();
  expect(threadPinDelta(420, 400, 24)).toBe(44);
  expect(threadPinDelta(376, 400, 24)).toBe(0);
});
