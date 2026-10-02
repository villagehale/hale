'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Scroll-reveal wrapper. The band is painted (opacity 1) unless a browser can
 * drive a view timeline, in which case it fades in as it enters and finishes
 * at opacity 1. prefers-reduced-motion shows it immediately. Content stays in
 * the DOM either way.
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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0, rootMargin: '0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className ? `${className} v4-reveal` : 'v4-reveal'}
      data-shown={shown ? 'true' : 'false'}
      style={delayMs > 0 ? { animationDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </div>
  );
}
