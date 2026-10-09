import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActivitiesHub from '../../app/[locale]/activities/page.js';
import LandingPage from '../../app/[locale]/page.js';
import TextPage from '../../app/[locale]/text/page.js';
import type { Locale } from '~/i18n/routing';

/**
 * Every run carries one tail, on its last bubble, and Hale's chips sit
 * outside the thread. French and Chinese have to render the new chrome.
 */

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

type Node = {
  classes: string[];
  children: Node[];
};

function classesOf(attrs: string): string[] {
  return /class="([^"]*)"/.exec(attrs)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
}

/** Element tree. Direct children are what the tail rule counts. */
function parse(html: string): Node {
  const root: Node = { classes: [], children: [] };
  const stack: Node[] = [root];
  const re = /<\/?([a-zA-Z][\w:-]*)([^>]*)>/g;
  for (const match of html.matchAll(re)) {
    const raw = match[0];
    const tag = match[1]?.toLowerCase() ?? '';
    const attrs = match[2] ?? '';
    const current = stack.at(-1);
    if (!current) break;
    if (raw.startsWith('</')) {
      if (stack.length > 1 && stack.at(-1) !== root) stack.pop();
      continue;
    }
    const node: Node = { classes: classesOf(attrs), children: [] };
    current.children.push(node);
    const self = raw.endsWith('/>') || VOID.has(tag);
    if (!self) stack.push(node);
  }
  return root;
}

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function has(node: Node, name: string): boolean {
  return node.classes.includes(name);
}

async function render(locale: Locale, page: 'home' | 'text' | 'activities'): Promise<string> {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
  const params = Promise.resolve({ locale });
  const element =
    page === 'home'
      ? await LandingPage({ params })
      : page === 'text'
        ? await TextPage({ params, searchParams: Promise.resolve({}) })
        : await ActivitiesHub({ params });
  return renderToStaticMarkup(element);
}

const SOURCES = ['home.tsx', 'text.tsx', 'activities.tsx', 'group-chats.tsx'].map((name) =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8'),
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('iMessage runs', () => {
  it('puts exactly one tail on the last bubble of every run', async () => {
    for (const locale of ['en', 'fr', 'zh'] as const) {
      for (const page of ['home', 'text', 'activities'] as const) {
        const html = await render(locale, page);
        const tree = parse(html);
        const runs: Node[] = [];
        walk(tree, (node) => {
          if (has(node, 'im-run')) runs.push(node);
        });
        expect(runs.length, `${locale} ${page}`).toBeGreaterThan(0);
        for (const run of runs) {
          const bubbles = run.children.filter((child) => has(child, 'im-b'));
          const tails = bubbles.filter((bubble) => has(bubble, 'tail'));
          expect(tails, `${locale} ${page}`).toHaveLength(1);
          expect(bubbles.at(-1)?.classes).toContain('tail');
        }
        walk(tree, (node) => {
          if (!has(node, 'im-thread')) return;
          walk(node, (inner) => {
            expect(inner.classes, `${locale} ${page}`).not.toContain('hs-did');
          });
        });
      }
    }
  });

  it('renders the new Messages chrome in French and Chinese', async () => {
    const fr = await render('fr', 'home');
    const zh = await render('zh', 'home');
    const text = await render('en', 'text');
    expect(fr).toContain('9 h 41');
    expect(fr).toContain('Distribué');
    expect(zh).toContain('上午9:41');
    expect(zh).toContain('已送达');
    expect(text).toContain('Delivered');
    expect(text).toContain('9:41 AM');
  });

  it('stops using the notification "now" key and leaves every other message key', () => {
    for (const source of SOURCES) {
      expect(source).not.toContain('t("now")');
      expect(source).not.toContain("t('now')");
    }
  });
});
