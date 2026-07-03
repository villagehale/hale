import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TrailView } from '~/lib/dashboard/mappers';
import { AccountMenuView } from './account-menu-view';
import { TrailTimeline } from './trail-timeline';

/**
 * Replay-masking regression guard (hard rule #1). PostHog session replay records
 * the live DOM and masks rendered text ONLY inside an element tagged
 * `[data-hale-pii]` (rrweb cascades the mask to that element's descendants —
 * POSTHOG_PII_SELECTOR in posthog-provider). So every on-screen child/family PII
 * field MUST sit under such an element, or the replay captures it as cleartext.
 *
 * The check is structural, not a substring: `stripMaskedSubtrees` excises the
 * full subtree of every `data-hale-pii` element from the rendered HTML, then we
 * assert the PII value is GONE from what remains. A field rendered outside any
 * tagged ancestor survives the strip and fails the test — which is exactly the
 * leak we are guarding against. (Removing a tag in the source turns these red;
 * see the red-before-green note in the PR.)
 */

/**
 * Remove the entire subtree of each element carrying `data-hale-pii`, leaving the
 * residual markup a replay would expose as readable text. Walks the tag stream
 * tracking depth so a nested same-name element can't close the masked region
 * early.
 */
function stripMaskedSubtrees(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('data-hale-pii', i);
    if (open === -1) {
      out += html.slice(i);
      break;
    }
    const tagStart = html.lastIndexOf('<', open);
    const tagName = /^<([a-zA-Z][\w-]*)/.exec(html.slice(tagStart))?.[1];
    if (!tagName) {
      out += html.slice(i, open + 'data-hale-pii'.length);
      i = open + 'data-hale-pii'.length;
      continue;
    }
    out += html.slice(i, tagStart);

    const openRe = new RegExp(`<${tagName}(\\s|>)`, 'g');
    const closeTag = `</${tagName}>`;
    let depth = 0;
    let cursor = tagStart;
    while (cursor < html.length) {
      openRe.lastIndex = cursor;
      const nextOpen = openRe.exec(html);
      const nextClose = html.indexOf(closeTag, cursor);
      if (nextClose === -1) {
        cursor = html.length;
        break;
      }
      if (nextOpen && nextOpen.index < nextClose) {
        depth += 1;
        cursor = nextOpen.index + 1;
        continue;
      }
      depth -= 1;
      cursor = nextClose + closeTag.length;
      if (depth === 0) break;
    }
    i = cursor;
  }
  return out;
}

describe('stripMaskedSubtrees (the test harness itself)', () => {
  it('removes a tagged subtree, including nested same-name children', () => {
    const html = renderToStaticMarkup(
      h(
        'div',
        null,
        h('div', { 'data-hale-pii': true }, h('div', null, 'SECRET')),
        h('p', null, 'visible'),
      ),
    );
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain('SECRET');
    expect(residue).toContain('visible');
  });
});

describe('account chip (every authed page) masks the parent + family identity', () => {
  const PARENT = 'Priya Raman';
  const FAMILY = 'The Raman household';

  const html = renderToStaticMarkup(
    h(AccountMenuView, {
      open: false,
      parentName: PARENT,
      familyName: FAMILY,
      canSignOut: true,
      menuId: 'm',
      onToggle: () => {},
      onSelect: () => {},
      onSignOut: () => {},
    }),
  );

  it('renders the identity at all (guards against a vacuous pass)', () => {
    expect(html).toContain(PARENT);
    expect(html).toContain(FAMILY);
  });

  it('keeps the parent name and family name inside a [data-hale-pii] subtree', () => {
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain(PARENT);
    expect(residue).not.toContain(FAMILY);
  });
});

describe('history timeline masks each entry summary + child name', () => {
  const entries: TrailView[] = [
    {
      id: 'e1',
      time: '14:30',
      date: 'Thursday, Jun 11',
      dayKey: '2026-06-11',
      tone: 'done',
      actor: 'hale',
      summary: 'carried out the action for Maya',
      noun: 'draft',
      link: '/approvals',
      childLabel: 'Maya',
    },
  ];

  const html = renderToStaticMarkup(h(TrailTimeline, { entries }));

  it('renders the entry text at all (guards against a vacuous pass)', () => {
    expect(html).toContain('Maya');
  });

  it('keeps the entry summary and the child name inside a [data-hale-pii] subtree', () => {
    const residue = stripMaskedSubtrees(html);
    // The summary sentence and the attributed child's name are both masked.
    expect(residue).not.toContain('Maya');
    // The non-PII frame — day heading, the deep link — survives the strip.
    expect(residue).toContain('Thursday, Jun 11');
    expect(residue).toContain('view this draft');
  });
});

/**
 * The approvals row is inline JSX on the server page (it loads its drafts from the
 * DB, so it can't be rendered with a fixture without standing up the query layer).
 * Guard it at the source instead: the row's PII-bearing expressions — the human
 * preview, the verdict summary, and the drafted-payload detail — must each sit
 * after a `data-hale-pii` marker so the replay masks the row body. This fails if a
 * future edit moves any of these fields out of the tagged container.
 */
describe('approvals page source tags the row body PII', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../app/(authed)/approvals/page.tsx', import.meta.url)),
    'utf8',
  );

  const piiExpressions = [
    '{approval.preview}',
    'detail={approval.summary}',
    '{approval.summary}',
    'payload={approval.payload}',
  ];

  it('each row-body PII field appears after the data-hale-pii marker', () => {
    const marker = source.indexOf('data-hale-pii');
    expect(marker).toBeGreaterThan(-1);
    for (const expr of piiExpressions) {
      const at = source.indexOf(expr);
      expect(at, `${expr} should be present`).toBeGreaterThan(-1);
      expect(at, `${expr} should be inside the data-hale-pii container`).toBeGreaterThan(marker);
    }
  });
});
