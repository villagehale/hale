import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApprovalView } from '~/lib/dashboard/approvals';
import type { HistoryView } from '~/lib/dashboard/history';
import { ApprovalCard, ReversibleCard } from './approval-card';
import { DismissButton } from './dismiss-button';

/**
 * In the approvals list every row renders identical "approve & send" / "dismiss
 * draft" / "undo this" controls. Without a per-row accessible name, a screen reader
 * hears the same button name N times with no way to tell which draft each acts on.
 *
 * That name is assembled by REFERENCE — `aria-labelledby` naming the button itself
 * plus the row's preview node — rather than by copying the preview into an
 * `aria-label`, because a session replay records attribute values verbatim past the
 * text mask (VIL-274, rule #1; the leak itself is guarded in
 * replay-pii-masking.test.ts). So these tests do what a screen reader does: resolve
 * the reference and assert the resulting name.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
};

function textContent(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text of the element carrying `id`. Throws when the reference dangles — a
 * dangling `aria-labelledby` leaves a control with NO accessible name at all, which
 * is the regression this file exists to catch. (These cards nest no same-name
 * element inside a referenced one, so the first matching close tag is the right one.) */
function textOfElement(html: string, id: string): string {
  const marker = html.indexOf(`id="${id}"`);
  if (marker === -1) throw new Error(`aria-labelledby points at #${id}, absent from the markup`);
  const tagName = /^<([a-zA-Z][\w-]*)/.exec(html.slice(html.lastIndexOf('<', marker)))?.[1];
  if (!tagName) throw new Error(`#${id} is not on an element`);
  const body = html.slice(html.indexOf('>', marker) + 1, html.indexOf(`</${tagName}>`, marker));
  return textContent(body);
}

/** The accessible name a screen reader computes for the button whose visible text is
 * `visible`: each id in its `aria-labelledby`, in order, resolved to that element's
 * text; falling back to the button's own content when it names nothing. */
function accessibleName(html: string, visible: string): string {
  const button = [...html.matchAll(/<button\b[^>]*>.*?<\/button>/gs)]
    .map((match) => match[0])
    .find((markup) => textContent(markup).includes(visible));
  if (!button) throw new Error(`no button reads "${visible}"`);
  const refs = /aria-labelledby="([^"]*)"/.exec(button)?.[1];
  if (!refs) return textContent(button);
  return refs
    .split(' ')
    .map((id) => textOfElement(html, id))
    .join(' ');
}

const PREVIEW = 'Reply to Dr. Okafor about the referral';

const approval: ApprovalView = {
  id: 'a1',
  actionType: 'reply_to_email',
  summary: 'Hale matched this to the referral thread',
  preview: PREVIEW,
  payload: { to: 'clinic@example.com', subject: 'Referral', body: 'Thank you!' },
  childId: 'c1',
  childLabel: 'Maya',
  verdict: 'approved',
  draftedAt: 'today at 8:04 am',
  teenRedacted: false,
  teenUnlockable: false,
};

const reversible: HistoryView = {
  ...approval,
  id: 'h1',
  actionType: 'calendar_add',
  preview: 'Added the swim lesson to your calendar',
  status: 'executed',
  resolvedAt: 'today at 8:06 am',
  undoable: true,
};

describe('approval-row buttons — per-row accessible names', () => {
  it('names approve and dismiss with their visible label PLUS the row preview', () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { approval }));
    expect(accessibleName(html, 'approve & send')).toBe(`approve & send ${PREVIEW}`);
    expect(accessibleName(html, 'dismiss draft')).toBe(`dismiss draft ${PREVIEW}`);
  });

  it('names the undo control with its visible label plus the placement it takes back', () => {
    const html = renderToStaticMarkup(createElement(ReversibleCard, { done: reversible }));
    expect(accessibleName(html, 'undo this')).toBe(`undo this ${reversible.preview}`);
  });

  it('gives two drafts on one page two different names, and two different references', () => {
    const other = { ...approval, id: 'a2', preview: 'Email the swim school waitlist' };
    const html = renderToStaticMarkup(
      createElement('ul', null, [
        createElement(ApprovalCard, { key: 'a1', approval }),
        createElement(ApprovalCard, { key: 'a2', approval: other }),
      ]),
    );
    // Both rows resolve, to different sentences — the point of naming them at all.
    expect(accessibleName(html, 'approve & send')).toBe(`approve & send ${PREVIEW}`);
    expect(html).toContain('id="a1-preview"');
    expect(html).toContain('id="a2-preview"');
    const refs = [...html.matchAll(/aria-labelledby="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('is stable across re-renders, so the reference keeps resolving', () => {
    const once = renderToStaticMarkup(createElement(ApprovalCard, { approval }));
    const twice = renderToStaticMarkup(createElement(ApprovalCard, { approval }));
    expect(twice).toBe(once);
  });

  it('names a button by its visible text when no row preview is supplied', () => {
    const html = renderToStaticMarkup(createElement(DismissButton, { actionId: 'a1' }));
    expect(html).not.toContain('aria-labelledby');
    expect(accessibleName(html, 'dismiss draft')).toBe('dismiss draft');
  });
});
