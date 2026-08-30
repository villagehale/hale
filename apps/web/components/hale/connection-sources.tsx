import { Calendar, FolderOpen, Mail } from 'lucide-react';
import type { FamilyConnectorView } from '~/lib/integrations/load';
import { describeScope } from '~/lib/integrations/scope-copy';
import { ConnectorDisconnectForm } from './connector-disconnect-form';
import { SettingsCard, SettingsRow } from './settings-card';

/**
 * The Google sources card — one row per connectable provider, built strictly on
 * what the integrations row can back: provider, status, granted scopes, and the
 * two dates. No account email or Google profile is ever stored, so no
 * "connected as name@gmail.com" is ever claimed. Scope chips render from the
 * CONNECTION's granted scopes (an unknown scope renders literally, never
 * relabelled read-only). Status honesty: `error` still holds tokens and is
 * retried, so it reads as connected-but-failing — never "not connected";
 * `revoked` (tokens purged) reads as the connect invitation again. A co-parent's
 * connection is visible at category level (rule #5 doctrine) — attributed,
 * without scope or sync detail, and non-actionable: only the owner can
 * disconnect.
 */
const SOURCES = [
  {
    provider: 'gcal',
    label: 'Google Calendar',
    icon: Calendar,
    blurb: 'Appointments, events, and reminders — read-only.',
  },
  {
    provider: 'gmail',
    label: 'Gmail',
    icon: Mail,
    blurb: 'Confirmations, forms, and benefit letters — read-only.',
  },
  {
    provider: 'gdrive',
    label: 'Google Drive',
    icon: FolderOpen,
    blurb: 'Documents you point Hale to — read-only.',
  },
] as const;

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeZone: 'UTC' }).format(value);
}

function viewerLine(c: FamilyConnectorView): string {
  const connected = c.connectedAt ? `Connected ${formatDate(c.connectedAt)}` : 'Connected';
  if (c.status === 'active') {
    return `${connected} · ${c.lastSyncAt ? `Last synced ${formatDate(c.lastSyncAt)}` : 'Not synced yet'}`;
  }
  if (c.status === 'error') {
    const lastGood = c.lastSyncAt ? `last synced ${formatDate(c.lastSyncAt)}` : 'never synced';
    return `${connected} · Sync failing (${lastGood}) — Hale retries on its own.`;
  }
  return `${connected} · Not syncing right now.`;
}

function coParentLine(c: FamilyConnectorView): string {
  const when = c.connectedAt ? ` · ${formatDate(c.connectedAt)}` : '';
  const failing = c.status === 'error' ? ' · sync failing' : '';
  return `Connected by your co-parent${when}${failing}`;
}

function ScopeChips({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1.5">
      {scopes.map((scope) => {
        const d = describeScope(scope);
        return (
          <span key={scope} className="pill pill-apricot">
            {d.label}
            {d.readOnly ? ' · read-only' : ''}
          </span>
        );
      })}
    </span>
  );
}

export function ConnectionSources({ connections }: { connections: FamilyConnectorView[] }) {
  return (
    <div className="flex flex-col gap-y-5">
      <p className="text-spruce leading-relaxed max-w-md">
        Hale never reaches outside your family until you connect a source. Each grant is read-only
        and scoped to one service, and what it feeds only becomes drafts you approve — nothing acts
        on its own.
      </p>
      <SettingsCard>
        {SOURCES.map((source) => {
          const live = connections
            .filter((c) => c.provider === source.provider && c.status !== 'revoked')
            .sort((a, b) => Number(b.ownedByViewer) - Number(a.ownedByViewer));
          const mine = live.find((c) => c.ownedByViewer);
          const connectHref = `/api/integrations/${source.provider}/connect`;

          const value =
            live.length === 0 ? (
              source.blurb
            ) : (
              <>
                {live.map((c, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: a static server render of at most one row per family member
                    key={i}
                    className={i > 0 ? 'mt-1 block' : 'block'}
                  >
                    {c.ownedByViewer ? (
                      <>
                        {viewerLine(c)}
                        <ScopeChips scopes={c.scopes} />
                      </>
                    ) : (
                      coParentLine(c)
                    )}
                  </span>
                ))}
              </>
            );

          const action = mine ? (
            <div className="flex flex-col items-start gap-1 sm:items-end">
              {mine.status !== 'active' ? (
                <a href={connectHref} className="meta text-spruce underline underline-offset-4">
                  reconnect
                </a>
              ) : null}
              <ConnectorDisconnectForm provider={source.provider} serviceLabel={source.label} />
            </div>
          ) : (
            <a href={connectHref} className="btn-secondary">
              Connect
            </a>
          );

          return (
            <SettingsRow
              key={source.provider}
              icon={source.icon}
              label={source.label}
              value={value}
              action={action}
            />
          );
        })}
      </SettingsCard>
    </div>
  );
}
