import type { LucideIcon } from 'lucide-react';
import { Icon } from '~/components/ui/icon';

/**
 * The flat Settings grammar (Instinct-adapted, Shore palette): a muted section
 * header + one-line explainer over a bordered card whose children read as rows.
 * Roles only — every color rides a token so both themes derive. Presentational;
 * the page owns all data and actions.
 */

export function SettingsSection({
  id,
  label,
  explainer,
  children,
}: {
  id: string;
  label: string;
  explainer?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-label={label}>
      <p className="eyebrow text-faded-sage">{label}</p>
      {explainer ? <p className="meta mt-1">{explainer}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function SettingsCard({ children }: { children: React.ReactNode }) {
  return <div className="settings-card">{children}</div>;
}

/**
 * One flat row: small icon · bold label · grey current-value line · right-aligned
 * action. Stacks below 480px (value under the label, action full-width) so a masked
 * phone is never truncated. `pii` tags the value line for replay masking (rule #1).
 */
export function SettingsRow({
  icon,
  label,
  value,
  pii = false,
  action,
}: {
  icon: LucideIcon;
  label: string;
  /** The grey current-value line; omit for action-only rows. */
  value?: React.ReactNode;
  pii?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="settings-flat-row">
      <div className="settings-flat-main">
        <span className="settings-flat-icon">
          <Icon as={icon} size={18} />
        </span>
        <div className="settings-flat-text">
          <p className="settings-flat-label">{label}</p>
          {value !== undefined ? (
            <p className="settings-flat-value" {...(pii ? { 'data-hale-pii': true } : {})}>
              {value}
            </p>
          ) : null}
        </div>
      </div>
      {action ? <div className="settings-flat-action">{action}</div> : null}
    </div>
  );
}
