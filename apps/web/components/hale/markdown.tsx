'use client';

import { Suspense, lazy } from 'react';

const MarkdownBody = lazy(() =>
  import('./markdown-body').then((m) => ({ default: m.MarkdownBody })),
);

/**
 * Renders an agent answer (markdown from the model) as formatted text — bold, lists,
 * headings, links — instead of leaking raw `**asterisks**`. The heavy react-markdown +
 * remark-gfm chain is code-split (./markdown-body) and loaded ONLY when the first model
 * answer renders, so it never rides into the coach route's initial First Load JS. Until
 * the parser chunk arrives, the raw (already human-readable) text shows as the fallback.
 * Styling lives in `.hale-markdown` (globals.css), keyed to the design tokens.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="hale-markdown">
      <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
        <MarkdownBody>{children}</MarkdownBody>
      </Suspense>
    </div>
  );
}
