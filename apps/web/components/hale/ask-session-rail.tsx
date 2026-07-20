'use client';

import { ChevronDown, PanelLeft, PanelLeftClose, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ASK_RAIL_LEFT_ATTR, ASK_RAIL_LEFT_KEY } from '~/lib/ask-rail';
import type { ConversationSummary } from '~/lib/coach/history';
import { groupConversations, sessionTimeLabel } from '~/lib/coach/session-groups';
import { useRailCollapse } from './use-rail-collapse';

interface AskSessionRailProps {
  /** RSC-rehydrated first page of the family's sessions (newest-active first). */
  initialConversations: ConversationSummary[];
  /** The conversation the rail marks active, or null for an unsaved new chat. */
  activeId: string | null;
  /** Bumps when a send opened/continued a thread → refetch the list. */
  refreshSignal: number;
  /** Clear to a fresh chat (owned by the thread hook). */
  onNewChat: () => void;
  /** Reopen a past session (owned by the thread hook). */
  onOpen: (id: string) => void;
}

/**
 * The Ask session rail (desktop handoff §4.4): "New chat" over the family's real
 * conversations grouped into Today / Earlier off the LOCAL day. The list is
 * RSC-seeded, then refetched whenever a send changes the set (refreshSignal), so a
 * just-finished chat appears. Honest sub-lines carry the last-active time only — the
 * history query has no category tag. Collapses (Cowork-style) to a 44px strip; the
 * width + content swap are CSS-driven off the pre-paint root attribute (no flash).
 */
export function AskSessionRail({
  initialConversations,
  activeId,
  refreshSignal,
  onNewChat,
  onOpen,
}: AskSessionRailProps) {
  const { collapsed, toggle } = useRailCollapse(ASK_RAIL_LEFT_KEY, ASK_RAIL_LEFT_ATTR);
  const [conversations, setConversations] = useState<ConversationSummary[]>(initialConversations);
  const [errored, setErrored] = useState(false);
  const requestSeq = useRef(0);
  // Today/Earlier bucketing + the row times are LOCAL-day/locale dependent, so the
  // server would mis-bucket and mis-format. Compute `now` only after mount; until then
  // the list is deferred (a skeleton) so server and client first render identically —
  // no hydration mismatch on the volatile time text.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => setNowMs(Date.now()), []);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setErrored(false);
    fetch('/api/coach/conversations')
      .then((res) => {
        if (!res.ok) throw new Error('list_failed');
        return res.json() as Promise<{ conversations: ConversationSummary[] }>;
      })
      .then((data) => {
        if (seq === requestSeq.current) setConversations(data.conversations);
      })
      .catch(() => {
        if (seq === requestSeq.current) setErrored(true);
      });
  }, []);

  // The RSC seeded the first render; only refetch on a later send. refreshSignal starts
  // at 0 and bumps to ≥1 on each completed send, so gating on it (not a mount ref) is
  // immune to Strict-Mode's double-invoked mount effect firing a needless fetch.
  useEffect(() => {
    if (refreshSignal === 0) return;
    load();
  }, [refreshSignal, load]);

  const { today, earlier } =
    nowMs === null ? { today: [], earlier: [] } : groupConversations(conversations, nowMs);
  const isEmpty = today.length === 0 && earlier.length === 0;

  return (
    <aside className="ask-rail ask-rail-left hidden shrink-0 self-stretch lg:block" aria-label="Chat history">
      <div className="ask-rail__full">
        <header className="flex items-center justify-between gap-2 px-1 pb-3">
          {/* A <p>, not a heading — the global `.main-stage h2` size would swell it;
              the aside's aria-label already names this landmark. */}
          <p className="eyebrow text-faded-sage">Chat history</p>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label="Collapse chat history"
            className="ask-rail-icon-btn cursor-pointer"
          >
            <PanelLeftClose aria-hidden size={16} />
          </button>
        </header>

        <button type="button" onClick={onNewChat} className="ask-new-chat cursor-pointer">
          <Plus aria-hidden size={15} />
          New chat
        </button>

        <div className="ask-rail-scroll mt-3">
          {nowMs === null ? (
            <SkeletonRows />
          ) : errored ? (
            <div className="px-1 py-6 text-center" role="alert">
              <p className="meta text-slate-green">Couldn&rsquo;t load your chats.</p>
              <button type="button" onClick={load} className="link mt-1 cursor-pointer text-[0.85rem]">
                Try again
              </button>
            </div>
          ) : isEmpty ? (
            <p className="meta px-1 py-6 text-center">No past chats yet.</p>
          ) : (
            <>
              <SessionGroup
                heading="Today"
                conversations={today}
                now={nowMs}
                activeId={activeId}
                onOpen={onOpen}
              />
              <SessionGroup
                heading="Earlier"
                conversations={earlier}
                now={nowMs}
                activeId={activeId}
                onOpen={onOpen}
              />
            </>
          )}
        </div>
      </div>

      {/* Collapsed 44px strip — expand + new chat only. */}
      <div className="ask-rail__strip">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label="Expand chat history"
          className="ask-rail-icon-btn cursor-pointer"
        >
          <PanelLeft aria-hidden size={16} />
        </button>
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          className="ask-rail-icon-btn cursor-pointer"
        >
          <Plus aria-hidden size={16} />
        </button>
      </div>
    </aside>
  );
}

/** One collapsible history group (Today / Earlier). The chevron rotates when folded;
 *  an empty group renders nothing so the rail never shows a bare heading. */
function SessionGroup({
  heading,
  conversations,
  now,
  activeId,
  onOpen,
}: {
  heading: string;
  conversations: ConversationSummary[];
  now: number;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (conversations.length === 0) return null;
  return (
    <section className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-1 py-1.5 cursor-pointer"
      >
        <ChevronDown
          aria-hidden
          size={13}
          className="text-faded-sage transition-transform"
          style={{ transform: open ? 'none' : 'rotate(-90deg)' }}
        />
        <span className="eyebrow text-faded-sage">{heading}</span>
      </button>
      {open ? (
        <ul className="space-y-0.5">
          {conversations.map((c) => (
            <li key={c.id}>
              <SessionRow conversation={c} now={now} active={c.id === activeId} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SessionRow({
  conversation,
  now,
  active,
  onOpen,
}: {
  conversation: ConversationSummary;
  now: number;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const title = conversation.title.trim() || 'Untitled chat';
  return (
    <button
      type="button"
      onClick={() => onOpen(conversation.id)}
      aria-current={active}
      className="ask-session-row w-full cursor-pointer px-2.5 py-2 text-left"
    >
      <span data-hale-pii className="block truncate text-[0.82rem] font-semibold text-spruce">
        {title}
      </span>
      <span className="meta">{sessionTimeLabel(conversation.lastMessageAt, now)}</span>
    </button>
  );
}

/** Three muted placeholder rows while the client-local `now` (grouping + times)
 *  resolves after mount — so the list never renders with a server-mismatched time. */
function SkeletonRows() {
  return (
    <ul className="space-y-1.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li key={i} className="px-2.5 py-2">
          <span className="block h-3 w-2/3 rounded bg-hairline" />
          <span className="mt-1.5 block h-2.5 w-12 rounded bg-hairline" />
        </li>
      ))}
    </ul>
  );
}
