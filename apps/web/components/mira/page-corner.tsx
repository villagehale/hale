import { LongDate } from './long-date';

interface PageCornerProps {
  /** Folio for this section (i, ii, iii, …). */
  folio: string;
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
        <span className="folio text-iron">{folio}</span>
        <span className="eyebrow text-iron">{section}</span>
      </div>
      <LongDate />
    </div>
  );
}
