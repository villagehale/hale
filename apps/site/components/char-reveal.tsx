import type { CSSProperties } from 'react';

/**
 * A paragraph that surfaces a character at a time as it crosses the viewport.
 *
 * Used once on the whole site — the founder's own account on /about — and that
 * is the point: a device that appears twice is a pattern, and a pattern this
 * loud would fight the copy everywhere else.
 *
 * The scroll link is CSS (`animation-timeline` over a view timeline named on the
 * paragraph — see `.char-reveal` in globals.css), so there is no scroll handler,
 * no observer, and no client bundle. Full opacity is the DEFAULT state, which
 * makes every failure mode the readable one: a browser without scroll-driven
 * animations, a reader who asked for less motion, and any crawler all get plain
 * settled prose.
 *
 * Characters are split into plain inline spans and the spaces are left as real
 * text between them, so line breaking, selection and find-in-page behave exactly
 * as they do in an ordinary paragraph.
 */
export function CharReveal({ text, className }: { text: string; className?: string }) {
  const chars = [...text];

  return (
    <p className={`char-reveal${className ? ` ${className}` : ''}`}>
      {chars.map((char, index) =>
        char === ' ' ? (
          // A space stays an ordinary text node: wrapping it would make every
          // gap a styled box and hand the line breaker a different problem.
          ' '
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the index IS the identity here — this is a fixed string split into positions, and position drives the stagger.
            key={index}
            className="char-reveal-char"
            style={{ '--c': index, '--n': chars.length } as CSSProperties}
          >
            {char}
          </span>
        ),
      )}
    </p>
  );
}
