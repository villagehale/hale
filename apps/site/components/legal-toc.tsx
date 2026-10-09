'use client';

import { useEffect, useState } from 'react';
import { currentLegalSection } from '~/lib/site/legal-toc';

/**
 * Sticky contents for /terms and /privacy. The bold marker is the section
 * whose heading is at or just under the sticky header, not the one that has
 * already left the viewport.
 */
export function LegalToc({
  label,
  sections,
}: {
  label: string;
  sections: { id: string; title: string }[];
}) {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const mark = () => {
      const header = document.querySelector('header');
      const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
      // A line on the header only flips after the heading has passed under the
      // bar, so the marker stays on the previous section while the next heading
      // is already at the top of the page. The band is the top of the viewport.
      const line = Math.min(window.innerHeight * 0.28, headerBottom + 180);
      const tops = sections.map((section) => {
        const node = document.getElementById(section.id);
        const heading = node?.querySelector('h2') ?? node;
        return heading?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      });
      const atEnd =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      const next = atEnd ? sections.length - 1 : currentLegalSection(tops, line);
      setCurrent((prev) => (prev === next ? prev : next));
    };
    mark();
    window.addEventListener('scroll', mark, { passive: true });
    window.addEventListener('resize', mark);
    return () => {
      window.removeEventListener('scroll', mark);
      window.removeEventListener('resize', mark);
    };
  }, [sections]);

  return (
    <nav className="lg-toc" aria-label={label}>
      <p className="hs-eyebrow">{label}</p>
      <ol>
        {sections.map((section, index) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={index === current ? 'link' : undefined}
              aria-current={index === current ? 'true' : undefined}
            >
              {section.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
