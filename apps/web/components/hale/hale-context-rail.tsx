import { FileText, FolderOpen, Mail } from 'lucide-react';
import type { ConnectorChip } from '~/components/hale/coach-context-panel';

/**
 * The /coach right rail (mockup 9) — three stacked context sections: DRAFTS (Gmail),
 * FROM DRIVE (a featured file), and RELATED FROM DRIVE (recent files). It is
 * CONNECTOR-populated: there is no live loader for real Gmail drafts or Drive files
 * yet, so the rail never fabricates a draft or a document. When a service is not
 * linked it shows an honest connect-prompt into Settings; when it IS linked (but the
 * loader is absent) it shows a calm empty state. The STRUCTURE matches the mockup;
 * the CONTENT is honest.
 *
 * Responsive: the rail is a fixed-width column on lg+ and is hidden below lg (it
 * drops away so the chat is single-column, full-width — no horizontal overflow on a
 * phone or tablet).
 */
export function HaleContextRail({ connectors }: { connectors: ConnectorChip[] }) {
  const gmailConnected = connectors.some((c) => c.provider === 'gmail' && c.connected);
  const driveConnected = connectors.some((c) => c.provider === 'gdrive' && c.connected);

  return (
    <aside
      aria-label="Context"
      className="hidden w-[20rem] shrink-0 self-stretch overflow-y-auto py-2 lg:block"
    >
      <div className="card space-y-6 p-5">
        <RailSection icon={Mail} title="Drafts">
          {gmailConnected ? (
            <EmptyNote>No drafts yet — Hale composes email drafts here for your approval.</EmptyNote>
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
