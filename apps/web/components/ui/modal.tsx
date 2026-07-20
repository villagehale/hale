'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A centered modal dialog (design handoff §4.8): a scrim backdrop over a white
 * card with a serif title + close button. Backdrop click and Escape close it, Tab
 * is trapped inside, focus moves in on open and restores to the trigger on close,
 * and the fadeUp entrance respects prefers-reduced-motion (in globals.css). Used
 * on desktop only — the callers keep their inline presentation below 1024px — so
 * this never fights the mobile layout.
 *
 * Presentation only: it wraps a caller's existing form untouched (the form owns
 * its fields, state and server action).
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = dialogRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled above; this scrim is a pointer convenience, the dialog itself is the accessible surface
    <div
      className="hale-modal-scrim"
      onClick={(e) => {
        // Close only on a real backdrop click — not a click that bubbled up from
        // inside the dialog (so no stopPropagation handler is needed on the panel).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="hale-modal"
        aria-modal="true"
        aria-labelledby={titleId}
        // biome-ignore lint/a11y/useSemanticElements: a portal scrim + focus-trap dialog, matching the app's hand-rolled role="menu" popovers rather than the native <dialog> element
        role="dialog"
      >
        <div className="hale-modal-head">
          <h2 id={titleId} className="hale-modal-title font-display">
            {title}
          </h2>
          <button
            type="button"
            className="hale-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="hale-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
