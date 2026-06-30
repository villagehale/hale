import { useEffect, useState } from 'react';

import { useReducedMotion } from './use-reduced-motion';

/**
 * Simulated token streaming for the placeholder Hale reply — reveals `full`
 * word-by-word so the thread never shows a long spinner. No API; when
 * reduce-motion is on, the text appears at once. Returns [shown, streaming].
 */
export function useTypewriter(full: string, active: boolean, wordMs = 55): [string, boolean] {
  const reduced = useReducedMotion();
  const [count, setCount] = useState(0);
  const words = full.split(' ');
  const total = words.length;

  useEffect(() => {
    if (!active) return;
    if (reduced) {
      setCount(total);
      return;
    }
    setCount(0);
    const id = setInterval(() => {
      setCount((c) => {
        if (c >= total) {
          clearInterval(id);
          return c;
        }
        return c + 1;
      });
    }, wordMs);
    return () => clearInterval(id);
  }, [active, reduced, total, wordMs]);

  const shown = words.slice(0, count).join(' ');
  return [shown, active && count < total];
}
