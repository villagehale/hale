'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { messageChip } from '~/components/hale/message-chip';
import { TintChip } from '~/components/ui/tint-chip';
import type { MessageView } from '~/lib/messages/mappers';

const MSG_PARAM = 'msg';

/**
 * Messages as a master–detail (design handoff §4.6/§4.8): a 320px note list beside
 * a 1fr detail pane. This repo's Messages are Hale's notes to the family (digests +
 * the action lifecycle), not a two-way provider chat, so the honest adaptation is
 * list → note detail rather than fabricated conversation bubbles.
 *
 * VIL-209 W3 — the list is Shore's conversation-row grammar (apps/mobile's Messages
 * screen): ONE flush-row surface whose rows are divided by the hairline token, each
 * row a tint-chip mark beside the note's label over a clamped preview, with the
 * stamp in a right column. The mark comes from the SAME semantic map the mobile
 * screen uses (`messageChip`), so a note reads identically on both.
 *
 * Every note on this surface is FROM Hale — there is no inbound lane here to
 * distinguish (the SMS conversation of record lives in `channel_messages`, which no
 * web surface reads yet), so the row leads with what the note IS rather than with a
 * sender, and nothing here pretends to be a two-way thread.
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
        <ul className="thread-list">
          {messages.map((message) => (
            <li key={message.id}>
              <button
                type="button"
                onClick={() => select(message.id)}
                aria-current={message.id === active.id}
                aria-controls="message-detail"
                className="thread-item"
              >
                <TintChip {...messageChip(message)} />
                <span className="thread-item-body">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="eyebrow text-ink">{message.eyebrow}</span>
                    <span className="meta tabular shrink-0 text-ink-3">{message.when}</span>
                  </span>
                  <span className="thread-item-snippet mt-0.5" data-hale-pii>
                    {message.body}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <article id="message-detail" className="messages-detail card" aria-live="polite">
        <div className="flex items-start gap-3">
          <TintChip {...messageChip(active)} />
          <div className="min-w-0 flex-1 flex items-baseline justify-between gap-3">
            <span className="eyebrow text-ink">{active.eyebrow}</span>
            <span className="meta tabular shrink-0 text-ink-3">{active.when}</span>
          </div>
        </div>
        <p className="text-lg text-ink leading-relaxed mt-4" data-hale-pii>
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
