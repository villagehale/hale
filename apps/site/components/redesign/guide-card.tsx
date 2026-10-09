import type { ReactNode } from 'react';

function GuideArrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

/**
 * The index guide card. Related guides on a guide page use the same card,
 * so the two lists cannot drift.
 */
export function GuideCard({
  stageParam,
  stageLabel,
  rangeLabel,
  question,
  description,
  href,
  readLabel,
  hidden,
}: {
  /** `?stage=` value. Omitted on related cards, which are not in the filter. */
  stageParam?: string;
  stageLabel: string;
  rangeLabel: string;
  question: string;
  description: string;
  href: string;
  readLabel: string;
  /** Set by the stage filter. Absent means the card stays visible. */
  hidden?: boolean;
}): ReactNode {
  return (
    <article
      className="hs-card sp-card sp-guide"
      data-stage={stageParam}
      hidden={hidden ? true : undefined}
    >
      <div className="sp-card-top">
        <span className="sp-tag">{stageLabel}</span>
        <span className="sp-num">{rangeLabel}</span>
      </div>
      <h3 className="hs-h3">{question}</h3>
      <p className="hs-p">{description}</p>
      <div className="sp-guide-more">
        <a className="sp-link" href={href}>
          <span>{readLabel}</span>
          <GuideArrow />
        </a>
      </div>
    </article>
  );
}
