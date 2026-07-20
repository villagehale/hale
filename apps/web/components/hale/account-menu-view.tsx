import Link from 'next/link';
import type { RefObject } from 'react';
import { ChevronsUpDown, LogOut, Settings } from 'lucide-react';
import { PLAN_DISPLAY, type PlanTier } from '@hale/types';
import { Icon } from '~/components/ui/icon';
import { LogoMark } from '~/components/hale/logo-mark';
import { SETTINGS_NAV } from '~/components/hale/nav';
import { ThemeToggle } from '~/components/hale/theme-toggle';

export interface AccountMenuViewProps {
  open: boolean;
  parentName: string | null;
  /** The family's plan, shown as the chip's secondary line per the desktop handoff. */
  planTier: PlanTier;
  canSignOut: boolean;
  menuId: string;
  onToggle: () => void;
  onSelect: () => void;
  /** The sign-out form action — injected by the wrapper so this presentational
   * view never imports the auth module (keeping it render-to-static testable). */
  onSignOut: () => void | Promise<void>;
  rootRef?: RefObject<HTMLDivElement | null>;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * The chip + popover markup, factored out of the stateful wrapper so it renders
 * without the shell/router context (the wrapper owns open-state and dismissal).
 * The chip's secondary line is the family's plan (design handoff); per the handoff
 * the popover is Settings + Sign out only; Appearance (the theme control) rides
 * along where it has always lived, and Sign out — an account action, not a
 * destination — sits below a divider. History moved out of this menu (it stays
 * reachable from the Approvals surface).
 */
export function AccountMenuView({
  open,
  parentName,
  planTier,
  canSignOut,
  menuId,
  onToggle,
  onSelect,
  onSignOut,
  rootRef,
  triggerRef,
}: AccountMenuViewProps) {
  const displayName = parentName?.trim() || 'your account';
  // Free reads "Free plan" (a gentle upgrade cue); paid tiers show the tier name.
  const planLabel =
    planTier === 'free' ? `${PLAN_DISPLAY.free.name} plan` : PLAN_DISPLAY[planTier].name;

  return (
    <div className="account-menu" ref={rootRef}>
      {open ? (
        <div className="account-pop" role="menu" id={menuId} aria-label="account">
          <Link
            href={SETTINGS_NAV.href}
            role="menuitem"
            className="account-pop-item"
            onClick={onSelect}
          >
            <Icon as={Settings} size={18} />
            <span>settings</span>
          </Link>
          <div className="account-pop-row">
            <span className="account-pop-row-label">appearance</span>
            <ThemeToggle />
          </div>
          {canSignOut ? (
            <>
              <div className="account-pop-divider" />
              <form action={onSignOut}>
                <button
                  type="submit"
                  role="menuitem"
                  className="account-pop-item account-pop-signout"
                >
                  <Icon as={LogOut} size={18} />
                  <span>sign out</span>
                </button>
              </form>
            </>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        ref={triggerRef}
        className="account-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={onToggle}
      >
        <LogoMark size={32} />
        <span className="account-chip-identity" data-hale-pii>
          <span className="account-chip-name">{displayName}</span>
          <span className="account-chip-family meta">{planLabel}</span>
        </span>
        <Icon as={ChevronsUpDown} size={16} className="account-chip-caret" />
      </button>
    </div>
  );
}
