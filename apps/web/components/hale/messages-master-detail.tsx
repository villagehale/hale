'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { MessageView } from '~/lib/messages/mappers';

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
  const active = messages.find((m) => m.id === selectedId) ?? messages[0];
  // The empty feed is handled by the page (calm copy); this renders only with notes.
  if (!active) return null;

  return (
    <div className="messages-md rise rise-2">
      <nav className="messages-list" aria-label="your notes from Hale">
        <ul className="flex flex-col gap-1">
          {messages.map((message) => (
            <li key={message.id}>
              <button
                type="button"
                onClick={() => setSelectedId(message.id)}
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

      <article id="message-detail" className="messages-detail card">
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
