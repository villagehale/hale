import type { RefObject } from 'react';
import { ChevronsUpDown, LogOut } from 'lucide-react';
import { PLAN_DISPLAY, type PlanTier } from '@hale/types';
import { Avatar } from '~/components/ui/avatar';
import { Icon } from '~/components/ui/icon';
import { ThemeToggle } from '~/components/hale/theme-toggle';

/** The parent's initials for the fallback disc — first + last name initial ("Barton
 * Dong" → "BD"), or a single initial for a one-word name. A neutral dot when there is
 * no name yet (onboarding incomplete) — the disc is never blank. */
function parentInitials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

export interface AccountMenuViewProps {
  open: boolean;
  parentName: string | null;
  /** The signed-in parent's photo (Google `user.image`), or null → the initials disc. */
  parentImage?: string | null;
  /** The family's plan — the chip's secondary line when no phone is enrolled. */
  planTier: PlanTier;
  /** The parent's MASKED SMS number (Instinct-style name + phone chip). Null when
   * not enrolled → the plan label stands in. Never the raw number (rule #1). */
  maskedPhone?: string | null;
  canSignOut: boolean;
  menuId: string;
  onToggle: () => void;
  /** The sign-out form action — injected by the wrapper so this presentational
   * view never imports the auth module (keeping it render-to-static testable). */
  onSignOut: () => void | Promise<void>;
  rootRef?: RefObject<HTMLDivElement | null>;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * The chip + popover markup, factored out of the stateful wrapper so it renders
 * without the shell/router context (the wrapper owns open-state and dismissal).
 * The chip's secondary line is the family's plan (design handoff).
 *
 * The popover holds NO destinations — only Appearance (the theme control) and, below
 * a divider, Sign out, an account action rather than a place. Settings is a nav stop
 * in its own right, and a second entry to it here gave the app two Settings; the
 * chip is the account, the nav is the map. History left the same way earlier (it
 * stays reachable from the Approvals surface).
 */
export function AccountMenuView({
  open,
  parentName,
  parentImage = null,
  planTier,
  maskedPhone = null,
  canSignOut,
  menuId,
  onToggle,
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
        <div
          className="account-pop"
          id={menuId}
          // biome-ignore lint/a11y/useSemanticElements: a non-modal account popover mixing a link, the appearance toggle, and sign-out (not pure menuitems) — matches the bell/location dialog pattern, Escape + outside-click close, not the native <dialog> (WEB-11)
          role="dialog"
          aria-label="account"
        >
          <div className="account-pop-row">
            <span className="account-pop-row-label">appearance</span>
            <ThemeToggle />
          </div>
          {canSignOut ? (
            <>
              <div className="account-pop-divider" />
              <form action={onSignOut}>
                <button type="submit" className="account-pop-item account-pop-signout">
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
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Your account"
        title="Your account"
        onClick={onToggle}
      >
        <Avatar tone="account" src={parentImage} initials={parentInitials(parentName)} size={32} />
        <span className="account-chip-identity" data-hale-pii>
          <span className="account-chip-name">{displayName}</span>
          {/* Instinct-style name + phone; the plan label stands in until a number
           * is enrolled. The masked value is still PII-tagged for replay masking. */}
          {maskedPhone ? (
            <span className="account-chip-family meta" data-hale-pii>
              {maskedPhone}
            </span>
          ) : (
            <span className="account-chip-family meta">You · {planLabel}</span>
          )}
        </span>
        <Icon as={ChevronsUpDown} size={16} className="account-chip-caret" />
      </button>
    </div>
  );
}
