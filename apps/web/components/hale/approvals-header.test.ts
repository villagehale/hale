import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalsHeader } from './approvals-header';

/**
 * The page title now lives in the shell drill hero ("Approvals", §3.2), so the
 * intro beneath it is state-adaptive WITHOUT a competing headline: nothing pending
 * reads calm ("All caught up", §4.8) and IS the empty state; a positive count is a
 * single trust line. The trust promise (rule #4) rides in both states. Rendered to
 * static markup so the full copy expands.
 */
function render(pendingCount: number): string {
  return renderToStaticMarkup(createElement(ApprovalsHeader, { pendingCount }));
}

describe('ApprovalsHeader', () => {
  it('is the "All caught up" empty state with nothing pending', () => {
    const html = render(0);
    expect(html).toContain('All caught up');
    expect(html).toContain('Nothing waiting for your approval');
    // The empty state is not a dead end — it points to the record of what's done.
    expect(html).toContain('href="/trail"');
    expect(html).toContain('see what Hale has taken care of');
  });

  it('is a single trust line when drafts are waiting (no competing headline)', () => {
    const html = render(3);
    expect(html).not.toContain('All caught up');
    // No hero-scale headline here — the shell drill hero carries the page title.
    expect(html).not.toContain('font-display text-[1.5rem]');
    expect(html).toContain('you decide');
  });

  it('surfaces the trust promise (rule #4) in both states', () => {
    const promise = 'It never acts on its own';
    expect(render(0)).toContain(promise);
    expect(render(2)).toContain(promise);
  });
});
