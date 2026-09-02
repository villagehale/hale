'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useSearchParams } from 'next/navigation';
import { createContext, useContext } from 'react';
import { parseWindowParam, WINDOW_OPTIONS, type WindowDays } from '~/lib/admin/window';

/**
 * The ONE global window dial. Every trend on the page consumes this context
 * and slices its pre-fetched 365-bucket array locally — flipping the dial is
 * a zero-round-trip re-time of the whole ledger.
 *
 * The dial RIDES THE URL: `?w=` is the source of truth, so a deep link opens
 * on the right window and a tab switch keeps it. A flip is a shallow
 * `history.replaceState` — Next syncs useSearchParams on those, so React
 * re-renders with zero server round trips, and back/forward stay honest.
 */
const WindowContext = createContext<WindowDays>(30);

export function useWindowDays(): WindowDays {
  return useContext(WindowContext);
}

export function WindowDialProvider({ children }: { children: React.ReactNode }) {
  const days = parseWindowParam(useSearchParams().get('w'));
  return <WindowContext.Provider value={days}>{children}</WindowContext.Provider>;
}

export function WindowDial() {
  const days = useWindowDays();
  const reduced = useReducedMotion();

  const flip = (option: WindowDays) => {
    const url = new URL(window.location.href);
    url.searchParams.set('w', String(option));
    window.history.replaceState(null, '', url);
  };

  return (
    <fieldset className="adm-dial">
      <legend className="sr-only">Trend window</legend>
      {WINDOW_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={days === option}
          onClick={() => flip(option)}
        >
          {days === option ? (
            <motion.span
              layoutId="adm-dial-thumb"
              className="adm-dial-thumb"
              transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40 }}
            />
          ) : null}
          <span className="adm-dial-label">{option}d</span>
        </button>
      ))}
    </fieldset>
  );
}
