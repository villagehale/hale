import { Bot, Calendar, FolderOpen, Mail, MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConnectorDisconnectForm } from '~/components/hale/connector-disconnect-form';
import { McpRevokeForm } from '~/components/hale/mcp-revoke-form';
import type { FamilyConnectorView } from '~/lib/integrations/load';
import { describeScope } from '~/lib/integrations/scope-copy';
import { describeSyncError } from '~/lib/integrations/sync-error';
import type { McpConnectionSummary } from '~/lib/mcp/oauth-store';
import { PortalHeading } from './heading';
import styles from './portal.module.css';

function liveRow(
  connections: FamilyConnectorView[],
  provider: string,
): FamilyConnectorView | undefined {
  return connections.find(
    (row) => row.provider === provider && row.status !== 'revoked' && row.ownedByViewer,
  );
}

function readOnly(row: FamilyConnectorView): boolean {
  return row.scopes.length > 0 && row.scopes.every((scope) => describeScope(scope).readOnly);
}

function sinceLine(row: FamilyConnectorView, since: string | null): string | null {
  const when = since ? `since ${since}` : null;
  const access = readOnly(row) ? 'Read-only' : null;
  const failing = row.status === 'error' ? describeSyncError(row.lastErrorCode)?.reason : null;
  return [access, when, failing].filter(Boolean).join(' · ') || null;
}

export function ConnectionsView({
  connections,
  assistants,
  maskedPhone,
  textsOn,
  gmailSince,
  calendarSince,
  driveSince,
}: {
  connections: FamilyConnectorView[];
  assistants: McpConnectionSummary[];
  maskedPhone: string | null;
  textsOn: boolean;
  gmailSince: string | null;
  calendarSince: string | null;
  driveSince: string | null;
}) {
  const gmail = liveRow(connections, 'gmail');
  const calendar = liveRow(connections, 'gcal');
  const drive = liveRow(connections, 'gdrive');

  return (
    <>
      <PortalHeading back title="Connections" lede="What Hale can read, and how it reaches you." />
      <div className={styles.one}>
        <section className={`${styles.card} ${styles.span}`}>
          <span className={styles.tag}>What Hale can read</span>
          <SourceRow
            icon={<Mail aria-hidden="true" />}
            title="Gmail"
            meta={gmail ? sinceLine(gmail, gmailSince) : null}
            action={
              gmail ? (
                <>
                  <span className={`${styles.state} ${styles.ok}`}>Connected</span>
                  <ConnectorDisconnectForm provider="gmail" serviceLabel="Gmail" />
                </>
              ) : (
                <a href="/api/integrations/gmail/connect" className={styles.secondary}>
                  Connect
                </a>
              )
            }
          />
          <SourceRow
            icon={<Calendar aria-hidden="true" />}
            title="Google Calendar"
            meta={
              calendar ? sinceLine(calendar, calendarSince) : 'Catches class invites and trip dates'
            }
            action={
              calendar ? (
                <>
                  <span className={`${styles.state} ${styles.ok}`}>Connected</span>
                  <ConnectorDisconnectForm provider="gcal" serviceLabel="Google Calendar" />
                </>
              ) : (
                <a href="/api/integrations/gcal/connect" className={styles.secondary}>
                  Connect
                </a>
              )
            }
          />
          {drive ? (
            <SourceRow
              icon={<FolderOpen aria-hidden="true" />}
              title="Google Drive"
              meta={sinceLine(drive, driveSince)}
              action={
                <>
                  <span className={`${styles.state} ${styles.ok}`}>Connected</span>
                  <ConnectorDisconnectForm provider="gdrive" serviceLabel="Google Drive" />
                </>
              }
            />
          ) : null}
          <p className={styles.text}>Disconnect anytime here, or tell Hale in your texts.</p>
        </section>
        <section className={`${styles.card} ${styles.span}`}>
          <span className={styles.tag}>How Hale reaches you</span>
          <SourceRow
            icon={<MessageCircle aria-hidden="true" />}
            title="Texts"
            meta={maskedPhone}
            action={textsOn ? <span className={`${styles.state} ${styles.ok}`}>On</span> : null}
          />
        </section>
        <section className={`${styles.card} ${styles.span}`}>
          <span className={styles.tag}>AI assistants</span>
          {assistants.length === 0 ? (
            <SourceRow
              icon={<Bot aria-hidden="true" />}
              title="None connected"
              meta="Let an assistant like ChatGPT or Claude read your Hale family info."
              action={null}
            />
          ) : (
            assistants.map((assistant) => (
              <SourceRow
                key={assistant.id}
                icon={<Bot aria-hidden="true" />}
                title={assistant.clientName}
                meta={null}
                action={<McpRevokeForm grantId={assistant.id} />}
              />
            ))
          )}
        </section>
      </div>
    </>
  );
}

function SourceRow({
  icon,
  title,
  meta,
  action,
}: {
  icon: ReactNode;
  title: string;
  meta: string | null;
  action: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.tile}>{icon}</span>
      <span>
        <h3>{title}</h3>
        {meta ? (
          <p className={styles.meta} data-hale-pii>
            {meta}
          </p>
        ) : null}
      </span>
      {action ? <span className={styles.end}>{action}</span> : <span />}
    </div>
  );
}
