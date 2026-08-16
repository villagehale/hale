import { Fragment } from 'react';
import type { CSSProperties, ElementType } from 'react';

/**
 * A headline that arrives a word at a time.
 *
 * Two things the subpages needed and did not have: the landing's staggered word
 * rise, and a headline that can hold more than one type style. Both are this
 * component, because they are the same problem — you cannot stagger words you
 * have not split, and once they are split the accent segment is simply the words
 * carrying a different class.
 *
 * A segment is a run of the headline in one style. Marking one `accent: true`
 * sets it in Source Serif italic with the amber halo (`.accent`), the brand's one
 * title gesture; every subpage headline gets exactly one. Segments are joined
 * with a single space, so punctuation that must hug the accent goes INSIDE the
 * accent segment ("a number," not "a number" + ", …").
 *
 * No client JavaScript: the words are real text in the server-rendered HTML and
 * the stagger is a per-word `animation-delay` (`.pull-word` in globals.css).
 * That is what keeps the heading readable for a crawler, for a reader whose JS
 * never arrives, and under prefers-reduced-motion.
 */

export interface HeadlineSegment {
  text: string;
  /** Sets this run in the serif-italic accent — one per headline. */
  accent?: boolean;
}

export function WordsPullUp({
  segments,
  as: Tag = 'h1',
  className,
}: {
  segments: readonly HeadlineSegment[];
  as?: ElementType;
  className?: string;
}) {
  // Flattened first so the beat runs across the whole headline rather than
  // restarting when the style changes mid-sentence.
  const words = segments.flatMap((segment) =>
    segment.text
      .split(' ')
      .filter(Boolean)
      .map((text) => ({ text, accent: segment.accent === true })),
  );

  return (
    <Tag className={className}>
      {words.map((word, index) => (
        <Fragment key={`${index}-${word.text}`}>
          <span
            className={`pull-word${word.accent ? ' accent' : ''}`}
            style={{ '--w': index } as CSSProperties}
          >
            {word.text}
          </span>
          {/* The space is a sibling of the word, never its last character: a
              browser trims trailing whitespace inside an inline-block, and the
              headline would run together. */}
          {index < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </Tag>
  );
}
