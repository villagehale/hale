import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Scroll-chaining guard (Touch & interaction): a scroll gesture that reaches the
 * edge of a modal / drawer / rail must NOT chain to the page locked behind it.
 * The fix lives beside the `overflow-y: auto` that creates each scroll region, so
 * this asserts every one of those containers also declares
 * `overscroll-behavior: contain`. (The bell/location popovers have no internal
 * scroll region — no max-height/overflow — so they can't chain and are excluded.)
 */
const CSS = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

/** The body of a top-level `.selector { ... }` rule (first close-brace wins; these
 * rules are flat, no nested braces). */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) return '';
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

const SCROLL_CONTAINERS = ['.hale-modal-scrim', '.hale-modal', '.sidebar', '.ask-rail-scroll'];

describe('overscroll-behavior: contain on the app scroll containers', () => {
  it.each(SCROLL_CONTAINERS)('%s scrolls AND contains its overscroll', (selector) => {
    const body = ruleBody(selector);
    expect(body, `${selector} rule not found`).not.toBe('');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
  });
});
