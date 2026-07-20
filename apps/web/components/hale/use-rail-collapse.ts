'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Collapse state for one Ask side rail, persisted like the sidebar. The VISIBLE
 * width + content swap are driven by CSS off a root data-attribute the pre-paint
 * script sets from localStorage (globals.css `.ask-rail-*`), so a collapsed rail
 * never flashes open on load. This hook only mirrors that attribute into React state
 * so the toggle button's aria/icon match, and writes the choice back on toggle —
 * exactly the AppShell sidebar pattern. Default (absent key) is OPEN.
 */
export function useRailCollapse(
  storageKey: string,
  datasetAttr: string,
): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(false);

  // The pre-paint script already set the attribute (and thus the rendered width);
  // mirror it into state after mount so the toggle's aria-expanded/icon match.
  useEffect(() => {
    setCollapsed(document.documentElement.dataset[datasetAttr] === '1');
  }, [datasetAttr]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {}
      document.documentElement.dataset[datasetAttr] = next ? '1' : '0';
      return next;
    });
  }, [storageKey, datasetAttr]);

  return { collapsed, toggle };
}
