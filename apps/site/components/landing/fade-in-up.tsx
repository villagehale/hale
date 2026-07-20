'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Scroll-reveal wrapper: content settles up and fades in the first time it
 * enters the viewport. Content is always in the DOM (SEO + no-JS text is
 * present); only its opacity/transform is animated. prefers-reduced-motion
 * shows it immediately with no transition.
 */
export function FadeInUp({
  children,
  className,
  delayMs = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delayMs?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [instant, setInstant] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInstant(true);
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
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(2.5rem)',
        transition: instant
          ? 'none'
          : 'opacity 1000ms var(--ease-breathe), transform 1000ms var(--ease-breathe)',
        transitionDelay: instant ? undefined : `${delayMs}ms`,
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  );
}
