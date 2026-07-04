import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApproveButton } from './approve-button';
import { DismissButton } from './dismiss-button';

/**
 * In the approvals list every row renders identical "approve & send" / "dismiss
 * draft" controls. Without a per-row accessible name, a screen reader hears the same
 * two button names N times with no way to tell which draft each acts on. These guard
 * that a supplied preview label produces a UNIQUE accessible name that still contains
 * the visible label text (WCAG "label in name"), and that omitting it falls back to
 * the plain visible label (no empty/duplicate aria-label).
 */

describe('approval-row buttons — per-row accessible names', () => {
  it('folds the draft preview into a unique aria-label that keeps the visible label', () => {
    const approve = renderToStaticMarkup(
      createElement(ApproveButton, { actionId: 'a1', label: 'Reply to Dr. Okafor about the referral' }),
    );
    expect(approve).toContain('aria-label="approve &amp; send: Reply to Dr. Okafor about the referral"');

    const dismiss = renderToStaticMarkup(
      createElement(DismissButton, { actionId: 'a1', label: 'Reply to Dr. Okafor about the referral' }),
    );
    expect(dismiss).toContain('aria-label="dismiss draft: Reply to Dr. Okafor about the referral"');
  });

  it('gives two different drafts two different accessible names', () => {
    const first = renderToStaticMarkup(
      createElement(ApproveButton, { actionId: 'a1', label: 'Book the 6-month checkup' }),
    );
    const second = renderToStaticMarkup(
      createElement(ApproveButton, { actionId: 'a2', label: 'Email the swim school waitlist' }),
    );
    const nameOf = (html: string) => html.match(/aria-label="([^"]*)"/)?.[1];
    expect(nameOf(first)).not.toEqual(nameOf(second));
  });

  it('emits no aria-label when no preview is supplied (visible text carries the name)', () => {
    const html = renderToStaticMarkup(createElement(DismissButton, { actionId: 'a1' }));
    expect(html).not.toContain('aria-label');
    expect(html).toContain('dismiss draft');
  });
});
