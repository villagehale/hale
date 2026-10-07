'use client';
import { Children, type ReactNode, isValidElement, useState } from 'react';

const STAGES = ['All stages', 'Newborn', 'Toddler', 'School age', 'Teenager'];

/** The handoff's stage tabs filter the existing published guide cards. */
export function GuideFilter({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState('All stages');
  const cards = Children.toArray(children).filter(
    (card) =>
      isValidElement<{ 'data-stage': string }>(card) &&
      (stage === 'All stages' || card.props['data-stage'] === stage),
  );
  return (
    <>
      <div className="sp-filter" aria-label="Filter guides by age">
        {STAGES.map((name) => (
          <button
            key={name}
            type="button"
            className={`sp-chip${stage === name ? ' on' : ''}`}
            aria-pressed={stage === name}
            onClick={() => setStage(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="sp-cards">{cards}</div>
      <p className="sr-only" aria-live="polite">
        {cards.length} guides
      </p>
    </>
  );
}
