'use client';

import { type ReactNode, useEffect, useState } from 'react';

/**
 * A card grid that turns into a horizontal snap rail on phones (globals.css, the
 * `max-width: 639.98px` density block) — reachable from a keyboard, and named for
 * a screen reader, ONLY while it actually has something to scroll.
 *
 * The condition is the whole point. A static `tabIndex={0}` would put five dead
 * tab stops in the desktop composition, where the grid wraps and nothing scrolls;
 * leaving it off entirely leaves the phone rails touch-only, which hides the
 * cards past the edge from anyone driving by keyboard. So the attributes come off
 * a measurement of the element itself — `scrollWidth` against `clientWidth`,
 * re-taken by a ResizeObserver — rather than a breakpoint we guess at, and they
 * come back off the moment the overflow goes away. Arrow-key scrolling is then
 * the browser's own, free, because the container is focusable.
 *
 * Enhancement only: the server markup carries none of these attributes, so
 * hydration matches and a crawler or a JS-less reader sees the page unchanged.
 */
export function ScrollRail({
  as: Tag = 'div',
  className,
  label,
  children,
}: {
  as?: 'div' | 'ol';
  className: string;
  label: string;
  children: ReactNode;
}) {
  const [rail, setRail] = useState<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!rail) return;
    // A sub-pixel excess is rounding, not a rail worth stopping the tab order for.
    const measure = () => setOverflowing(rail.scrollWidth - rail.clientWidth > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [rail]);

  return (
    <Tag
      ref={setRail}
      className={className}
      // `region` is what gives the scroll container a name — but only on the
      // generic one. On the <ol> it would replace the list role and cost the
      // "list, 3 items" announcement, and `list` takes an accessible name itself.
      role={overflowing && Tag === 'div' ? 'region' : undefined}
      aria-label={overflowing ? label : undefined}
      tabIndex={overflowing ? 0 : undefined}
    >
      {children}
    </Tag>
  );
}
