'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The landing-v2 entrance primitive — one IntersectionObserver behind the four
 * `.v2-*` motion classes in globals.css (heading blur-rise, text rise, image
 * mask-wipe, hairline draw). Content is real text in the DOM from the first
 * byte; only opacity/transform/filter/clip-path move, and the observer fires
 * once.
 *
 * prefers-reduced-motion is answered twice on purpose: this component skips the
 * observer and paints the finished state on mount, and the stylesheet zeroes the
 * transitions independently. Either alone would be enough; a reader who has
 * asked for stillness should not depend on which one runs.
 */

const VARIANT_CLASS = {
  heading: 'v2-reveal',
  text: 'v2-reveal-soft',
  mask: 'v2-mask',
  rule: 'v2-rule',
} as const;

type Variant = keyof typeof VARIANT_CLASS;
type Tag = 'div' | 'span' | 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'li' | 'figure';

export function Reveal({
  variant = 'heading',
  as: Tag = 'div',
  className,
  id,
  children,
}: {
  variant?: Variant;
  as?: Tag;
  className?: string;
  id?: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: '0px 0px -80px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      id={id}
      className={className ? `${VARIANT_CLASS[variant]} ${className}` : VARIANT_CLASS[variant]}
      data-shown={shown ? 'true' : undefined}
    >
      {children}
    </Tag>
  );
}
