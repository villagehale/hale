'use client';

import {
  Children,
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useEffect,
  useState,
} from 'react';
import {
  filterStageFromSearch,
  filterStatusLine,
  hrefWithStage,
  nextFilterStage,
} from '~/lib/answers/guide-stage';

export interface GuideFilterStage {
  param: string;
  label: string;
  count: number;
}

/**
 * Stage chips and the card list on /answers.
 *
 * The cards are server-rendered children. With no JavaScript every card is
 * visible and All stages is selected. After mount, `?stage=` hides the rest
 * with the hidden attribute — nothing unmounts, and the page above the list
 * does not move. useSearchParams is deliberately not used: it would opt the
 * static page out of prerender.
 */
export function GuideFilter({
  groupLabel,
  allLabel,
  total,
  stages,
  statusTemplate,
  emptyHeading,
  seeAllLabel,
  children,
}: {
  groupLabel: string;
  allLabel: string;
  total: number;
  stages: readonly GuideFilterStage[];
  /** "Showing {n} of {total} guides" — placeholders filled as the chip changes. */
  statusTemplate: string;
  emptyHeading: string;
  seeAllLabel: string;
  children: ReactNode;
}) {
  const [stage, setStage] = useState<string | null>(null);
  const known = stages.map((item) => item.param).join('|');

  useEffect(() => {
    const params = known.split('|').filter((item) => item.length > 0);
    const apply = () => setStage(filterStageFromSearch(window.location.search, params));
    apply();
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, [known]);

  function select(next: string | null) {
    const resolved = nextFilterStage(stage, next);
    if (resolved === stage) return;
    const href = hrefWithStage(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
      resolved,
    );
    window.history.replaceState(null, '', href);
    setStage(resolved);
  }

  const selected = stages.find((item) => item.param === stage);
  const shown = selected ? selected.count : total;
  const empty = selected !== undefined && selected.count === 0;

  const cards = Children.map(children, (child) => {
    if (!isValidElement<{ 'data-stage'?: string; stageParam?: string }>(child)) return child;
    const dataStage = child.props['data-stage'] ?? child.props.stageParam;
    const hidden = stage !== null && dataStage !== stage;
    return cloneElement(child as ReactElement<{ hidden?: boolean }>, {
      hidden: hidden ? true : undefined,
    });
  });

  return (
    <>
      <div
        className="sp-filter"
        // biome-ignore lint/a11y/useSemanticElements: the approved filter is a labelled group of aria-pressed chips, not a form fieldset
        role="group"
        aria-label={groupLabel}
      >
        <button
          type="button"
          className="sp-chip"
          aria-pressed={stage === null}
          data-stage="all"
          onClick={() => select(null)}
        >
          {allLabel}
          <span className="sp-chip-n" aria-hidden="true">
            {total}
          </span>
        </button>
        {stages
          .filter((item) => item.count > 0)
          .map((item) => (
            <button
              key={item.param}
              type="button"
              className="sp-chip"
              aria-pressed={stage === item.param}
              data-stage={item.param}
              onClick={() => select(item.param)}
            >
              {item.label}
              <span className="sp-chip-n" aria-hidden="true">
                {item.count}
              </span>
            </button>
          ))}
      </div>
      <p
        className="gd-sr"
        // biome-ignore lint/a11y/useSemanticElements: the approved status line is a polite live region, not a form output
        role="status"
        aria-live="polite"
      >
        {filterStatusLine(statusTemplate, shown, total, selected ? selected.label : null)}
      </p>
      <div className="sp-cards">
        {cards}
        {empty ? (
          <article className="hs-card sp-card sp-filter-empty">
            <p className="sp-tag">{selected.label}</p>
            <h3 className="hs-h3">{emptyHeading}</h3>
            <div className="sp-guide-more">
              <button type="button" className="sp-link" onClick={() => select(null)}>
                <span>{seeAllLabel}</span>
              </button>
            </div>
          </article>
        ) : null}
      </div>
    </>
  );
}
