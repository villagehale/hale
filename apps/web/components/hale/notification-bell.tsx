'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Mascot } from '~/components/hale/mascot';
import { Icon } from '~/components/ui/icon';
import type { NotificationItem } from '~/lib/dashboard/notifications';

const SEEN_KEY = 'hale.notif.seen.v1';
/** Cap the persisted seen-set so it can't grow without bound. */
const SEEN_CAP = 60;

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeSeen(ids: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-SEEN_CAP)));
  } catch {
    // A private-mode / disabled storage just means the dot re-lights next load —
    // never a crash, and never a fabricated "read" state.
  }
}

/**
 * The top-bar notification bell (design handoff §3.2). Its unread dot and dropdown
 * read the SAME real items — pending approvals + Hale's recent notes (already teen-
 * redacted from the loaders, rule #1). Opening the dropdown marks everything read
 * (clears the dot) by folding the current item ids into a persisted seen-set, so the
 * dot only ever reflects genuinely new items, never a fabricated count.
 */
export function NotificationBell({ items }: { items: NotificationItem[] }) {
  const [open, setOpen] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Memoised off the (server-stable) items prop so the effect/callback depend on a
  // stable array identity — they re-run only when the notification set truly changes.
  const ids = useMemo(() => items.map((item) => item.id), [items]);

  // After paint, light the dot when any current item hasn't been seen. Runs on the
  // client only, so the server render is deterministic (dot off) — no hydration skew.
  useEffect(() => {
    const seen = readSeen();
    setHasUnread(ids.some((id) => !seen.has(id)));
  }, [ids]);

  const markRead = useCallback(() => {
    const seen = readSeen();
    for (const id of ids) seen.add(id);
    writeSeen([...seen]);
    setHasUnread(false);
  }, [ids]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) markRead();
      return next;
    });
  };

  return (
    <div className="bell-root" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={toggle}
        className="topbar-bell"
        aria-label={hasUnread ? 'Notifications — new items' : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
      >
        <Icon as={Bell} size={20} />
        {hasUnread ? <span className="bell-dot" aria-hidden /> : null}
      </button>

      {open ? (
        <div
          className="bell-pop"
          id={menuId}
          // biome-ignore lint/a11y/useSemanticElements: a non-modal notifications popover with a "mark all read" action + a footer link (not pure menuitems), Escape + outside-click close, not the native <dialog>
          role="dialog"
          aria-label="Notifications"
        >
          <div className="bell-pop-head">
            <span className="font-display font-semibold text-[0.95rem]">Notifications</span>
            {items.length > 0 ? (
              <button type="button" className="bell-pop-clear" onClick={markRead}>
                Mark all read
              </button>
            ) : null}
          </div>

          {items.length > 0 ? (
            <ul className="bell-pop-list">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="bell-pop-item"
                    onClick={() => setOpen(false)}
                  >
                    <span className="eyebrow bell-pop-eyebrow">{item.eyebrow}</span>
                    <span className="bell-pop-body" data-hale-pii>
                      {item.body}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="bell-pop-empty">
              <Mascot pose="swim" size={64} />
              <p className="bell-pop-empty-title font-display">You&rsquo;re all caught up</p>
              <p className="meta">Nothing waiting for your approval.</p>
            </div>
          )}

          {items.length > 0 ? (
            <Link href="/approvals" className="bell-pop-foot" onClick={() => setOpen(false)}>
              Review approvals
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
