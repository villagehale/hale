'use client';

import { type ReactNode, useState } from 'react';
import { ChildScope, type ScopeChild } from './child-scope';

/**
 * The Home per-child scope filter — narrows the stacked "today, per child" feed to
 * one child, or shows the whole family (the default, always first). The per-child
 * sections are rendered on the SERVER and passed in as nodes keyed by childId, so
 * all the card markup (and its teen-safe redaction) stays server-side; this client
 * island only owns the filter state and which sections to show.
 *
 * The filter only appears for a family with more than one child — a scope chip over
 * a single child clarifies nothing, so it stays out of the way.
 */
export function HomeChildFilter({
  kids,
  sections,
}: {
  kids: ScopeChild[];
  sections: ReadonlyArray<{ childId: string; node: ReactNode }>;
}) {
  const [scope, setScope] = useState<string | null>(null);
  const visible = scope === null ? sections : sections.filter((s) => s.childId === scope);

  return (
    <div className="space-y-8 lg:space-y-10">
      {kids.length > 1 ? (
        <ChildScope
          variant="filter"
          legend="show today for"
          kids={kids}
          value={scope}
          onChange={setScope}
        />
      ) : null}
      <div className="space-y-12 lg:space-y-16">
        {visible.map((section) => (
          <div key={section.childId}>{section.node}</div>
        ))}
      </div>
    </div>
  );
}
