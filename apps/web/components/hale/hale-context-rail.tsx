import { FileText, FolderOpen, Mail, Sparkles } from 'lucide-react';
import type { ConnectorChip } from '~/components/hale/coach-context-panel';

/**
 * The /coach right rail (mockup 9) — connector-powered context: DRAFTS (Gmail),
 * FROM DRIVE / RELATED (Drive files). It is CONNECTOR-populated: there is no live
 * loader for real Gmail drafts or Drive files yet, so the rail never fabricates a
 * draft or a document. When NOTHING is linked it shows ONE honest connect-prompt for
 * all three Google services (Gmail, Calendar, Drive — Hale drafts emails, adds to
 * your calendar, and surfaces files). Once a service is linked its section appears
 * (calm empty state until the loader lands). The STRUCTURE matches the mockup; the
 * CONTENT is honest.
 *
 * Responsive: fixed-width column on lg+, hidden below lg (chat goes single-column,
 * full-width — no horizontal overflow on phone/tablet).
 */
export function HaleContextRail({ connectors }: { connectors: ConnectorChip[] }) {
  const gmailConnected = connectors.some((c) => c.provider === 'gmail' && c.connected);
  const driveConnected = connectors.some((c) => c.provider === 'gdrive' && c.connected);
  const calendarConnected = connectors.some((c) => c.provider === 'gcal' && c.connected);
  const anyConnected = gmailConnected || driveConnected || calendarConnected;

  return (
    <aside
      aria-label="Context"
      className="hidden w-[20rem] shrink-0 self-stretch overflow-y-auto py-2 lg:block"
    >
      <div className="card space-y-6 p-5">
        {anyConnected ? (
          <>
            <RailSection icon={Mail} title="Drafts">
              {gmailConnected ? (
                <EmptyNote>
                  No drafts yet — Hale composes email drafts here for your approval.
                </EmptyNote>
              ) : (
                <ConnectPrompt line="Connect Gmail to draft & send emails from Hale." />
              )}
            </RailSection>

            <hr className="rule" />

            {driveConnected ? (
              <>
                <RailSection icon={FolderOpen} title="From Drive">
                  <EmptyNote>No recent files.</EmptyNote>
                </RailSection>

                <hr className="rule" />

                <RailSection icon={FileText} title="Related from Drive">
                  <EmptyNote>No related files yet.</EmptyNote>
                </RailSection>
              </>
            ) : (
              <RailSection icon={FolderOpen} title="From Drive">
                <ConnectPrompt line="Connect Google Drive to surface your family's files." />
              </RailSection>
            )}
          </>
        ) : (
          <RailSection icon={Sparkles} title="Connect Hale">
            <ConnectPrompt line="Connect Gmail, Calendar & Drive so Hale can draft emails, add appointments to your calendar, and surface your family's files." />
          </RailSection>
        )}
      </div>
    </aside>
  );
}

function RailSection({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Mail;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <p className="eyebrow flex items-center gap-2 text-faded-sage">
        <Icon aria-hidden size={14} />
        {title}
      </p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="meta">{children}</p>;
}

/** The honest connect-prompt when a service is not linked — a calm line into
 * Settings, never a fabricated draft or file. */
function ConnectPrompt({ line }: { line: string }) {
  return (
    <div className="space-y-2">
      <p className="meta">{line}</p>
      <a href="/settings" className="link inline-block text-[0.85rem]">
        Connect in Settings
      </a>
    </div>
  );
}
