'use client';

import { Fragment, useEffect, useRef, useState } from 'react';

/**
 * A word-by-word reveal: each word fades up with a staggered delay the first
 * time the text scrolls into view. Words are plain text in the DOM (SEO-safe);
 * spaces between them are real spaces so the browser wraps naturally.
 * prefers-reduced-motion renders every word static and instant.
 */
export function AnimatedText({
  text,
  className,
  as: Tag = 'span',
  baseDelayMs = 0,
  stepMs = 40,
}: {
  text: string;
  className?: string;
  as?: 'span' | 'h2' | 'p';
  baseDelayMs?: number;
  stepMs?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(false);
  const [instant, setInstant] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInstant(true);
      setActive(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const words = text.split(' ');

  return (
    <Tag ref={ref as never} className={className}>
      {words.map((word, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static word split that never reorders — the index disambiguates repeated words.
        <Fragment key={`${word}-${i}`}>
          <span
            className={active && !instant ? 'hale-anim-word' : undefined}
            style={{
              display: 'inline-block',
              opacity: active ? 1 : 0,
              animationDelay: active && !instant ? `${baseDelayMs + i * stepMs}ms` : undefined,
            }}
          >
            {word}
          </span>{' '}
        </Fragment>
      ))}
    </Tag>
  );
}
