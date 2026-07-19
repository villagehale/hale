'use client';

import type { Route } from 'next';
import { useEffect, useId, useRef, useState } from 'react';
import { ChildSwitcherView, type SwitcherChild } from '~/components/hale/child-switcher-view';

/**
 * The sidebar child switcher: the chip shows one child, the popover switches which
 * one and links to "Add child". This wrapper owns the open-state, the selected
 * child, and dismissal (Escape + click-outside) — the same ownership split as
 * AccountMenu. Selecting a child sets which child the chip shows; binding the wider
 * app to the active child is a later phase (mirrors the prototype's local `active`).
 *
 * The mobile drawer closes on route change (AppShell watches the pathname), so the
 * "Add child" link needs no explicit close here.
 */
export function ChildSwitcher({
  kids,
  addHref = '/family' as Route,
}: {
  kids: SwitcherChild[];
  addHref?: Route;
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(kids[0]?.id ?? null);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <ChildSwitcherView
      open={open}
      kids={kids}
      activeId={activeId}
      menuId={menuId}
      addHref={addHref}
      onToggle={() => setOpen((prev) => !prev)}
      onSelect={(id) => {
        setActiveId(id);
        setOpen(false);
      }}
      rootRef={rootRef}
      triggerRef={triggerRef}
    />
  );
}
