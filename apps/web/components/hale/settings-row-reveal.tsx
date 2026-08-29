'use client';

import type { LucideIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { SettingsRow } from '~/components/hale/settings-card';

/**
 * A flat row whose action button reveals its edit machinery inline (the Name and
 * Phone rows). The children stay server-rendered (passed through as a prop); this
 * wrapper owns only the open state, with the button labelled and wired to the
 * panel it controls.
 */
export function SettingsRowReveal({
  icon,
  label,
  value,
  pii = false,
  actionLabel,
  children,
}: {
  icon: LucideIcon;
  label: string;
  value?: React.ReactNode;
  pii?: boolean;
  /** The closed-state button label ("Change", "Link"). Open always reads "Close". */
  actionLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div>
      <SettingsRow
        icon={icon}
        label={label}
        value={value}
        pii={pii}
        action={
          <button
            type="button"
            className="btn-secondary"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((prev) => !prev)}
          >
            {open ? 'Close' : actionLabel}
          </button>
        }
      />
      {open ? (
        <div id={panelId} className="settings-flat-panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}
