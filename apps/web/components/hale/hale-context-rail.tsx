'use client';

import { FileText, FolderOpen, Mail, PanelRight, PanelRightClose, Sparkles } from 'lucide-react';
import type { ConnectorChip } from '~/components/hale/coach-context-panel';
import { ASK_RAIL_RIGHT_ATTR, ASK_RAIL_RIGHT_KEY } from '~/lib/ask-rail';
import { useRailCollapse } from './use-rail-collapse';

/**
 * The /coach right rail (desktop handoff §4.4) — connector-powered context: DRAFTS
 * (Gmail), FROM DRIVE / RELATED (Drive files). It is CONNECTOR-populated: there is no
 * live loader for real Gmail drafts or Drive files yet, so the rail never fabricates a
 * draft or a document. When NOTHING is linked it shows ONE honest connect-prompt for
 * all three Google services. Once a service is linked its section appears (calm empty
 * state until the loader lands). The STRUCTURE matches the mockup; the CONTENT is honest.
 *
 * Collapses (Cowork-style) to a 44px strip — width + content swap CSS-driven off the
 * pre-paint root attribute (no flash). The strip shows a red dot when a draft is
 * pending (`hasPendingDraft`), driven by real conversation state — never fabricated.
 *
 * Responsive: fixed-width column on lg+, hidden below lg (chat goes single-column,
 * full-width — no horizontal overflow on phone/tablet).
 */
export function HaleContextRail({
  connectors,
  hasPendingDraft = false,
}: {
  connectors: ConnectorChip[];
  /** True when the active conversation has an un-acted draft/action Hale proposed —
   * the only real "pending" signal available; when false, no dot (honest). */
  hasPendingDraft?: boolean;
}) {
  const { collapsed, toggle } = useRailCollapse(ASK_RAIL_RIGHT_KEY, ASK_RAIL_RIGHT_ATTR);
  const gmailConnected = connectors.some((c) => c.provider === 'gmail' && c.connected);
  const driveConnected = connectors.some((c) => c.provider === 'gdrive' && c.connected);
  const calendarConnected = connectors.some((c) => c.provider === 'gcal' && c.connected);
  const anyConnected = gmailConnected || driveConnected || calendarConnected;

  return (
    <aside
      aria-label="Context"
      className="ask-rail ask-rail-right hidden shrink-0 self-stretch lg:block"
    >
      <div className="ask-rail__full">
        <header className="flex items-center justify-between gap-2 px-1 pb-3">
          {/* A <p>, not a heading — the global `.main-stage h2` size would swell it;
              the aside's aria-label already names this landmark. */}
          <p className="eyebrow text-faded-sage">Context</p>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label="Collapse context"
            className="ask-rail-icon-btn cursor-pointer"
          >
            <PanelRightClose aria-hidden size={16} />
          </button>
        </header>

        <div className="ask-rail-scroll">
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
        </div>
      </div>

      {/* Collapsed 44px strip — expand + a red dot when a draft is pending. */}
      <div className="ask-rail__strip">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={hasPendingDraft ? 'Expand context — a draft is waiting' : 'Expand context'}
          className="ask-rail-icon-btn relative cursor-pointer"
        >
          <PanelRight aria-hidden size={16} />
          {hasPendingDraft ? <span className="ask-rail-dot" aria-hidden /> : null}
        </button>
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
