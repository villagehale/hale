import type { ReactNode } from 'react';

/**
 * One FAQ row. Native `<details>` so it works before JavaScript: keyboard,
 * find-in-page, and print come from the element. No `name` (several rows can
 * be open at once) and no `open` (every row starts collapsed). The answer
 * stays in the server HTML.
 */
export function FaqItem({
  id,
  question,
  children,
}: {
  id: string;
  question: string;
  children: ReactNode;
}) {
  return (
    <details className="hs-qa hs-acc" id={id}>
      <summary>
        <h3 className="hs-h3">{question}</h3>
        <span className="hs-acc-ic" aria-hidden="true">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M3 8h10" />
            <path className="v" d="M8 3v10" />
          </svg>
        </span>
      </summary>
      <div className="hs-acc-body">
        <p className="hs-p">{children}</p>
      </div>
    </details>
  );
}
