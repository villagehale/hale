import { LongDate } from './long-date';

interface PageCornerProps {
  /** Optional folio for this section (i, ii, iii, …). Omit on surfaces whose
   * order isn't a real sequence — a number there reads as a false rank. */
  folio?: string;
  /** Section name — printed right after the folio. */
  section: string;
}

/**
 * Running head at the top-right of every desktop page — the small page
 * corner that signals "you are reading a bound document, not browsing
 * a dashboard". Hidden on mobile (the running head sits in the sticky
 * header there).
 */
export function PageCorner({ folio, section }: PageCornerProps) {
  return (
    <div className="page-corner">
      <div className="flex items-baseline gap-3">
        {folio ? <span className="folio">{folio}</span> : null}
        <span className="eyebrow text-spruce">{section}</span>
      </div>
      <LongDate />
    </div>
  );
}
