'use client';

import { motion, useReducedMotion } from 'motion/react';
import { createContext, useContext, useState } from 'react';
import { WINDOW_OPTIONS, type WindowDays } from '~/lib/admin/window';

/**
 * The ONE global window dial. Every trend on the page consumes this context
 * and slices its pre-fetched 365-bucket array locally — flipping the dial is
 * a zero-round-trip re-time of the whole ledger.
 */
const WindowContext = createContext<WindowDays>(30);

export function useWindowDays(): WindowDays {
  return useContext(WindowContext);
}

export function WindowDialProvider({ children }: { children: React.ReactNode }) {
  const [days, setDays] = useState<WindowDays>(30);
  const reduced = useReducedMotion();

  return (
    <WindowContext.Provider value={days}>
      <div className="adm-dial-row">
        <fieldset className="adm-dial">
          <legend className="sr-only">Trend window</legend>
          {WINDOW_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={days === option}
              onClick={() => setDays(option)}
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
      </div>
      {children}
    </WindowContext.Provider>
  );
}
