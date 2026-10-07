'use client';

import { useEffect, useRef } from 'react';

/** Keep the calendar still while Hale's next follow-up takes focus. */
export function LandingMotion() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = marker.current?.closest('main');
    const stages = [...(root?.querySelectorAll<HTMLElement>('.redo-watch-marker') ?? [])];
    if (!root || stages.length !== 2 || !('IntersectionObserver' in window)) return;

    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let observer: IntersectionObserver | undefined;
    const update = () => {
      const readingLine = innerHeight * 0.45;
      root.dataset.watchStep = String(
        stages.reduce((step, stage, index) =>
          stage.getBoundingClientRect().top <= readingLine ? index + 1 : step,
        0),
      );
    };
    const setup = () => {
      observer?.disconnect();
      if (reduced.matches) {
        delete root.dataset.watchReady;
        delete root.dataset.watchStep;
        return;
      }
      root.dataset.watchReady = 'true';
      observer = new IntersectionObserver(update, { rootMargin: '-44% 0px -55% 0px' });
      for (const stage of stages) observer.observe(stage);
      update();
    };
    setup();
    reduced.addEventListener('change', setup);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      reduced.removeEventListener('change', setup);
      window.removeEventListener('resize', update);
      delete root.dataset.watchReady;
      delete root.dataset.watchStep;
    };
  }, []);
  return <span ref={marker} hidden />;
}
