import Link from 'next/link';
import type { Route } from 'next';
import type { RefObject } from 'react';
import { ChevronsUpDown, Plus } from 'lucide-react';
import { Avatar } from '~/components/ui/avatar';
import { Icon } from '~/components/ui/icon';
import { childInitials } from '~/lib/family/child-initials';

/** One child as the sidebar switcher shows it: identity + a short age/stage line. */
export interface SwitcherChild {
  id: string;
  name: string;
  /** Optional last name — the second monogram letter when present (rule #1: only the
   * child's own stored surname, never a parent's). */
  lastName?: string | null;
  /** A short "how old" line — the live-derived stage label (e.g. "toddler"). */
  ageLabel: string;
  /** The child's photo (uploaded avatar's signed URL), or null → initials. Wired by
   * the child-avatar upload lane; the switcher renders initials until it is set. */
  avatarUrl?: string | null;
}

export interface ChildSwitcherViewProps {
  open: boolean;
  kids: SwitcherChild[];
  /** The child currently shown on the chip. */
  activeId: string | null;
  menuId: string;
  onToggle: () => void;
  onSelect: (id: string) => void;
  /** Where "Add child" goes — the existing add-child surface (the Family page). */
  addHref: Route;
  rootRef?: RefObject<HTMLDivElement | null>;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * The child-switcher chip + upward popover at the foot of the sidebar, factored
 * out of the stateful wrapper so it renders without router/shell context (mirrors
 * AccountMenuView). The chip shows the active child (avatar initial + name + age);
 * the popover lists every child with the active one marked, then "Add child". With
 * no children yet it degrades to a single "Add a child" prompt — never a fake name.
 *
 * It reuses the account chip + popover classes so the collapsed-rail folding rules
 * (which target .account-chip / .account-pop) apply to the switcher for free.
 */
export function ChildSwitcherView({
  open,
  kids,
  activeId,
  menuId,
  onToggle,
  onSelect,
  addHref,
  rootRef,
  triggerRef,
}: ChildSwitcherViewProps) {
  // No children yet → a single "Add a child" prompt (never a fabricated name).
  const active = kids.find((c) => c.id === activeId) ?? kids[0];
  if (!active) {
    return (
      <Link href={addHref} className="account-chip" title="Add a child">
        <span className="child-avatar" aria-hidden="true">
          <Icon as={Plus} size={16} />
        </span>
        <span className="account-chip-identity">
          <span className="account-chip-name">Add a child</span>
          <span className="account-chip-family meta">Start their profile</span>
        </span>
      </Link>
    );
  }

  return (
    <div className="account-menu" ref={rootRef}>
      {open ? (
        <div className="account-pop" role="menu" id={menuId} aria-label="switch child">
          {kids.map((child) => (
            <button
              key={child.id}
              type="button"
              role="menuitem"
              aria-current={child.id === active.id ? 'true' : undefined}
              className="account-pop-item"
              onClick={() => onSelect(child.id)}
            >
              <Avatar
                tone="child"
                src={child.avatarUrl ?? null}
                initials={childInitials(child.name, child.lastName)}
                size={32}
              />
              <span data-hale-pii>{child.name}</span>
            </button>
          ))}
          <div className="account-pop-divider" />
          <Link href={addHref} role="menuitem" className="account-pop-item account-pop-add">
            <span className="child-avatar" aria-hidden="true">
              <Icon as={Plus} size={16} />
            </span>
            <span>Add child</span>
          </Link>
        </div>
      ) : null}

      <button
        type="button"
        ref={triggerRef}
        className="account-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Switch child"
        onClick={onToggle}
        title={active.name}
      >
        <Avatar
          tone="child"
          src={active.avatarUrl ?? null}
          initials={childInitials(active.name, active.lastName)}
          size={32}
        />
        <span className="account-chip-identity" data-hale-pii>
          <span className="account-chip-name">{active.name}</span>
          <span className="account-chip-family meta">{active.ageLabel}</span>
        </span>
        <Icon as={ChevronsUpDown} size={16} className="account-chip-caret" />
      </button>
    </div>
  );
}
