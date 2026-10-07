'use client';

import { Children, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/** Read layout once, then update compositor properties without React renders. */
export function updateGalleryFocus(node: HTMLDivElement, lift: number) {
  const cards = [...node.children] as [HTMLElement, HTMLElement, ...HTMLElement[]];
  const center = node.scrollLeft + node.clientWidth / 2;
  const stride = cards[1].offsetLeft - cards[0].offsetLeft;
  const positions = cards.map((card) => ({
    card,
    distance: Math.abs(card.offsetLeft + card.offsetWidth / 2 - center),
  }));
  for (const { card, distance } of positions) {
    const focus = Math.max(0, 1 - distance / stride);
    card.style.transform = `translate3d(0, ${lift * (1 - focus)}px, 0) scale(${0.8 + 0.2 * focus})`;
    card.style.opacity = String(0.25 + 0.75 * focus);
  }
  const distance = Math.min(...positions.map((position) => position.distance));
  return { nearest: positions.findIndex((position) => position.distance === distance), distance };
}

const GALLERY_LABELS = {
  carousel: 'Family group chat examples',
  instructions: 'Swipe or use arrow keys to change the group chat example',
  previous: 'Previous group chat',
  next: 'Next group chat',
  slide: (index: number, count: number) => `Example ${index + 1} of ${count}`,
};

/** Native swipe/scroll snap; only the settled center card owns playback. */
export function ChatGallery({
  children,
  labels = GALLERY_LABELS,
}: {
  children: ReactNode;
  labels?: {
    carousel: string;
    instructions: string;
    previous: string;
    next: string;
    slide: (index: number, count: number) => string;
  };
}) {
  const track = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef(1);
  const frame = useRef<number | undefined>(undefined);
  const lift = useRef(48);
  const inFlight = useRef(false);
  const [active, setActive] = useState(1);
  const [scrolling, setScrolling] = useState(false);
  const [ready, setReady] = useState(false);
  const count = Children.count(children);
  current.current = active;

  const align = useCallback((index: number, behavior: ScrollBehavior) => {
    const node = track.current;
    const card = node?.children.item(index) as HTMLElement | null;
    if (node && card)
      node.scrollTo({
        left: card.offsetLeft - (node.clientWidth - card.offsetWidth) / 2,
        behavior,
      });
  }, []);
  const settle = useCallback(() => {
    if (!track.current) return;
    const { nearest, distance } = updateGalleryFocus(track.current, lift.current);
    if (distance > 2) return;
    inFlight.current = false;
    setActive(nearest);
    setScrolling(false);
  }, []);
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const resizeFocus = () => {
      lift.current = Number.parseFloat(getComputedStyle(node).getPropertyValue('--gallery-lift'));
      align(current.current, 'auto');
      updateGalleryFocus(node, lift.current);
    };
    resizeFocus();
    setReady(true);
    const resize = new ResizeObserver(resizeFocus);
    resize.observe(node);
    node.addEventListener('scrollend', settle);
    return () => {
      resize.disconnect();
      node.removeEventListener('scrollend', settle);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      clearTimeout(timer.current);
    };
  }, [align, settle]);
  useEffect(() => {
    track.current?.dispatchEvent(
      new CustomEvent('hale:gallerychange', { bubbles: true, detail: { active, scrolling } }),
    );
  }, [active, scrolling]);

  const move = (index: number) => {
    const next = Math.max(0, Math.min(count - 1, index));
    if (next === active && !scrolling) return;
    inFlight.current = true;
    setScrolling(true);
    setActive(next);
    align(next, matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  };

  return (
    <section
      className="chat-gallery"
      aria-label={labels.carousel}
      aria-roledescription="carousel"
    >
      <div
        ref={track}
        className="hs-chats"
        data-chat-gallery="true"
        data-gallery-scrolling={scrolling}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Native scroll region supports keyboard navigation.
        tabIndex={0}
        aria-label={labels.instructions}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (!inFlight.current) {
            const card = node.children.item(current.current) as HTMLElement;
            const delta =
              node.scrollLeft - (card.offsetLeft - (node.clientWidth - card.offsetWidth) / 2);
            if (Math.abs(delta) > 2) {
              inFlight.current = true;
              setScrolling(true);
              setActive(Math.max(0, Math.min(count - 1, current.current + Math.sign(delta))));
            }
          }
          if (frame.current === undefined)
            frame.current = requestAnimationFrame(() => {
              frame.current = undefined;
              if (track.current) updateGalleryFocus(track.current, lift.current);
            });
          // Older browsers without scrollend still need a settled-scroll fallback.
          if (!('onscrollend' in node)) {
            clearTimeout(timer.current);
            timer.current = setTimeout(settle, 140);
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            move(active + (event.key === 'ArrowRight' ? 1 : -1));
          }
        }}
      >
        {Children.map(children, (child, index) => (
          <article
            className="gallery-slide"
            data-gallery-active={index === active}
            aria-roledescription="slide"
            aria-label={labels.slide(index, count)}
          >
            {child}
          </article>
        ))}
      </div>
      <div className="gallery-controls" hidden={!ready}>
        <button
          type="button"
          className="gallery-arrow"
          aria-label={labels.previous}
          disabled={scrolling || active === 0}
          onClick={() => move(active - 1)}
        >
          ←
        </button>
        <span className="gallery-position" aria-live="polite" aria-atomic="true">
          {String(active + 1).padStart(2, '0')} / {String(count).padStart(2, '0')}
        </span>
        <button
          type="button"
          className="gallery-arrow"
          aria-label={labels.next}
          disabled={scrolling || active === count - 1}
          onClick={() => move(active + 1)}
        >
          →
        </button>
      </div>
    </section>
  );
}
