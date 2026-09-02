'use client';

import { Phone, Ruler, UserRound } from 'lucide-react';
import { useId, useState } from 'react';
import { SettingsRow } from '~/components/hale/settings-card';

/** The reveal rows' icons, resolved CLIENT-SIDE by name: a Server Component cannot
 * pass a component function across the RSC boundary (it is not serializable), so the
 * page names the icon and this map owns the reference. */
const REVEAL_ICONS = { user: UserRound, phone: Phone, ruler: Ruler } as const;
export type RevealIconName = keyof typeof REVEAL_ICONS;

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
  icon: RevealIconName;
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
        icon={REVEAL_ICONS[icon]}
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
