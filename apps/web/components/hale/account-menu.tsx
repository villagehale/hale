'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AccountMenuView } from '~/components/hale/account-menu-view';
import { useShell } from '~/components/hale/app-shell';
import { signOutAction } from '~/lib/auth-actions';

/**
 * The account chip at the foot of the sidebar — the signed-in parent's name over a
 * "View profile" line into the account page. Clicking it opens the account menu;
 * Escape and a click outside dismiss it. The markup lives in AccountMenuView; this
 * wrapper owns the open-state and dismissal.
 *
 * Falls back to a neutral name when the Google profile carries none yet (onboarding
 * incomplete): the chip never shows an empty identity.
 */
export function AccountMenu({
  parentName,
  canSignOut = false,
}: {
  parentName: string | null;
  /** Sign out only appears for a real session — never in the dev preview. */
  canSignOut?: boolean;
}) {
  const { closeDrawer } = useShell();
  const [open, setOpen] = useState(false);
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
    <AccountMenuView
      open={open}
      parentName={parentName}
      canSignOut={canSignOut}
      menuId={menuId}
      onToggle={() => setOpen((prev) => !prev)}
      onSelect={() => {
        setOpen(false);
        closeDrawer();
      }}
      onSignOut={signOutAction}
      rootRef={rootRef}
      triggerRef={triggerRef}
    />
  );
}
