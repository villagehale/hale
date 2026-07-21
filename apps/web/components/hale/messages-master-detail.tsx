'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { MessageView } from '~/lib/messages/mappers';

const MSG_PARAM = 'msg';

/**
 * Messages as a master–detail (design handoff §4.6/§4.8): a 320px note list beside
 * a 1fr detail pane. This repo's Messages are Hale's notes to the family (digests +
 * the action lifecycle), not a two-way provider chat, so the honest adaptation is
 * list → note detail rather than fabricated conversation bubbles.
 *
 * The rule-#1/#4 contract from the old card grid is preserved: only a drafted row's
 * DETAIL leads anywhere — to /approvals, where the parent decides — and a redacted
 * body is shown verbatim, never un-redacted (the loader already applied redaction).
 * Below lg the two panes stack (list, then the selected note) so nothing overflows.
 */
export function MessagesMasterDetail({ messages }: { messages: MessageView[] }) {
  const [selectedId, setSelectedId] = useState(messages[0]?.id ?? '');

  // Deep-link support: on mount, honour ?msg=<id> when it names a real note, so a
  // shared or bookmarked link opens that note. Client-only — the server render (and
  // the no-param default) shows the newest note.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get(MSG_PARAM);
    if (id && messages.some((m) => m.id === id)) setSelectedId(id);
  }, [messages]);

  const active = messages.find((m) => m.id === selectedId) ?? messages[0];
  // The empty feed is handled by the page (calm copy); this renders only with notes.
  if (!active) return null;

  // Reflect the selection in the URL (replaceState — no navigation, keeps history)
  // so a specific note can be deep-linked / Cmd+click-shared like companion/village.
  function select(id: string) {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set(MSG_PARAM, id);
    window.history.replaceState(window.history.state, '', url);
  }

  return (
    <div className="messages-md rise rise-2">
      <nav className="messages-list" aria-label="your notes from Hale">
        <ul className="flex flex-col gap-1">
          {messages.map((message) => (
            <li key={message.id}>
              <button
                type="button"
                onClick={() => select(message.id)}
                aria-current={message.id === active.id}
                aria-controls="message-detail"
                className="thread-item"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="eyebrow text-spruce">{message.eyebrow}</span>
                  <span className="meta tabular shrink-0">{message.when}</span>
                </span>
                <span className="thread-item-snippet" data-hale-pii>
                  {message.body}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <article id="message-detail" className="messages-detail card" aria-live="polite">
        <div className="flex items-baseline justify-between gap-3">
          <span className="eyebrow text-spruce">{active.eyebrow}</span>
          <span className="meta tabular shrink-0">{active.when}</span>
        </div>
        <p className="text-lg text-spruce leading-relaxed mt-3" data-hale-pii>
          {active.body}
        </p>
        {active.actionState === 'drafted_for_approval' ? (
          <Link href="/approvals" className="link mt-4 inline-block">
            decide on activity &rarr;
          </Link>
        ) : null}
      </article>
    </div>
  );
}
