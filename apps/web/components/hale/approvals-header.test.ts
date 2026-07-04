import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalsHeader } from './approvals-header';

/**
 * The Approvals header is state-adaptive: the pending count IS the information.
 * Zero pending reads calm ("all clear") and carries the empty-state line itself;
 * a positive count leads with the number as the hero and never says "all clear".
 * The trust promise (rule #4) rides in both states. Rendered to static markup so
 * the full headline + meta expand, the same way the village feed is tested.
 */
function render(pendingCount: number): string {
  return renderToStaticMarkup(createElement(ApprovalsHeader, { pendingCount }));
}

describe('ApprovalsHeader', () => {
  it('reads "all clear" with nothing pending, and is itself the empty state', () => {
    const html = render(0);
    expect(html).toContain('all clear');
    // The old, wrong copy dominated even the empty state — it must be gone here.
    expect(html).not.toContain('waiting for your yes');
    // The header carries the empty-state line, so no separate panel is needed.
    expect(html).toContain('it parks it here for your yes');
    // The empty state is not a dead end — it points to the record of what's done.
    expect(html).toContain('href="/trail"');
    expect(html).toContain('see what Hale has taken care of');
  });

  it('leads with the count as the hero when drafts are waiting', () => {
    const html = render(3);
    // The number is the accent (apricot-deep), leading the sentence.
    expect(html).toContain('text-apricot-deep">3</span> drafts waiting for your yes');
    expect(html).not.toContain('all clear');
  });

  it('uses the singular "draft" for exactly one pending', () => {
    const html = render(1);
    expect(html).toContain('text-apricot-deep">1</span> draft waiting for your yes');
    expect(html).not.toContain('1 drafts');
  });

  it('surfaces the trust promise (rule #4) in both states', () => {
    const promise = 'It never acts on its own';
    expect(render(0)).toContain(promise);
    expect(render(2)).toContain(promise);
  });
});
