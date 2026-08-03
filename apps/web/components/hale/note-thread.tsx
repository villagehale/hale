'use client';

import { ArrowUp } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { readNdjson } from '~/components/hale/use-ask-hale';
import { Icon } from '~/components/ui/icon';
import type { MessageView } from '~/lib/messages/mappers';
import { noteReplyRequest } from '~/lib/messages/note-reply';
import { loadNoteThreadAction } from '~/lib/messages/note-thread-action';

/**
 * A Hale note as a two-way thread — VIL-209 W4, the web half of the mobile thread
 * screen (`apps/mobile/src/app/(details)/thread/[id].tsx`).
 *
 * Web `/messages` had no reply capability at all: W3 (#392) styled the list and named
 * this as the one honest behaviour gap, because the backend already has both halves.
 * Nothing new is designed here — the transcript comes from `loadNoteThread` (the same
 * loader `/api/mobile/note-thread` calls) and a reply is a POST to the existing
 * `/api/coach` anchored by `noteKey`, which resolves-or-creates ONE conversation per
 * (family, note). So a reply sent on the phone and a reply sent here land in the same
 * thread, and a re-open replays it.
 *
 * Two lanes, never blended: turns already persisted on the server render first and
 * are NOT re-fetched after a send, then the turns added this session — so a just-sent
 * reply can never double-render against a re-read.
 *
 * Delivery is honest (never a fake-delivered bubble): a reply goes sent → streaming →
 * settled, and a failed run leaves the answer bubble in an error state with a retry
 * that re-sends the same question.
 *
 * Rule #1: this component is only mounted for a note that `canReplyToNote` allows —
 * a teen-redacted note gets no thread and no composer, exactly as on mobile.
 */

type SessionTurn =
  | { id: string; role: 'you'; text: string }
  | {
      id: string;
      role: 'hale';
      text: string;
      streaming: boolean;
      errored: boolean;
      /** The reply that produced this answer — re-sent on retry. */
      question: string;
    };

type HaleTurn = Extract<SessionTurn, { role: 'hale' }>;

const REPLY_FAILED = 'That didn’t reach Hale. Check your connection and try again.';

export function NoteThread({ note }: { note: MessageView }) {
  const [serverTurns, setServerTurns] = useState<{ role: 'user' | 'assistant'; content: string }[]>(
    [],
  );
  const [turns, setTurns] = useState<SessionTurn[]>([]);

  // Replay the note's prior exchange when it opens, and clear BOTH lanes first.
  //
  // The clear is the load-bearing part: without it, selecting a second note shows the
  // first note's replies under it — verified, and not hypothetical. This component owns
  // that invariant rather than leaning on the caller to key it on the note id, so it is
  // correct wherever it is mounted and the guarantee lives with the state it guards.
  // `live` drops an in-flight load whose note the parent has already navigated away from.
  useEffect(() => {
    let live = true;
    setServerTurns([]);
    setTurns([]);
    loadNoteThreadAction(note.id).then((thread) => {
      if (live) setServerTurns(thread.turns);
    });
    return () => {
      live = false;
    };
  }, [note.id]);

  function patchHale(id: string, fn: (turn: HaleTurn) => HaleTurn) {
    setTurns((prev) => prev.map((t) => (t.id === id && t.role === 'hale' ? fn(t) : t)));
  }

  async function runStream(haleId: string, question: string) {
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(noteReplyRequest(note, question)),
      });
      if (!res.ok || !res.body) throw new Error(REPLY_FAILED);
      await readNdjson(res.body, (event) => {
        if (event.type === 'delta') patchHale(haleId, (t) => ({ ...t, text: t.text + event.text }));
        // An intermediate tool turn streamed text that is NOT the answer — drop it.
        if (event.type === 'reset') patchHale(haleId, (t) => ({ ...t, text: '' }));
        if (event.type === 'error') {
          patchHale(haleId, (t) => ({ ...t, errored: true, text: t.text || REPLY_FAILED }));
        }
      });
      // Settle by construction even if the stream closed without a terminal event, so
      // a cursor is never left blinking forever.
      patchHale(haleId, (t) => (t.streaming ? { ...t, streaming: false } : t));
    } catch {
      patchHale(haleId, (t) => ({
        ...t,
        streaming: false,
        errored: true,
        text: t.text || REPLY_FAILED,
      }));
    }
  }

  function send(text: string) {
    const question = text.trim();
    if (!question) return;
    const stamp = Date.now();
    const haleId = `hale-${stamp}`;
    setTurns((prev) => [
      ...prev,
      { id: `you-${stamp}`, role: 'you', text: question },
      { id: haleId, role: 'hale', text: '', streaming: true, errored: false, question },
    ]);
    void runStream(haleId, question);
  }

  function retry(turn: HaleTurn) {
    patchHale(turn.id, (t) => ({ ...t, text: '', streaming: true, errored: false }));
    void runStream(turn.id, turn.question);
  }

  return (
    <div className="note-thread">
      {serverTurns.length + turns.length > 0 ? (
        <div className="note-turns" data-hale-pii>
          {serverTurns.map((turn, i) => (
            <p
              // Transcript turns carry no id (the loader returns role + content only) and
              // never reorder — the position IS the identity here.
              key={`server-${i}-${turn.role}`}
              className={turn.role === 'user' ? 'note-bubble note-bubble-out' : 'note-bubble note-bubble-in'}
            >
              {turn.content}
            </p>
          ))}
          {turns.map((turn) =>
            turn.role === 'you' ? (
              <p key={turn.id} className="note-bubble note-bubble-out">
                {turn.text}
              </p>
            ) : (
              <HaleBubble key={turn.id} turn={turn} onRetry={() => retry(turn)} />
            ),
          )}
        </div>
      ) : null}
      <Composer onSend={send} />
    </div>
  );
}

/** Hale's answer while it is live: a quiet "thinking" line until the first token, the
 * growing answer as it streams, or an honest failure with a retry — never a bubble
 * that claims an answer arrived when the run failed. */
function HaleBubble({ turn, onRetry }: { turn: HaleTurn; onRetry: () => void }) {
  if (turn.errored) {
    return (
      <span className="note-bubble note-bubble-in">
        <span className="text-destructive">{turn.text}</span>
        <button type="button" className="link note-retry" onClick={onRetry}>
          Try again
        </button>
      </span>
    );
  }
  if (turn.streaming && turn.text.length === 0) {
    return <p className="note-bubble note-bubble-in text-ink-3 italic">Hale is thinking…</p>;
  }
  return <p className="note-bubble note-bubble-in">{turn.text}</p>;
}

/** The reply row: the app's own `.field` input plus a brand send button. Deliberately
 * NOT a bespoke bordered pill — the field treatment (and its known border-contrast
 * gap, VIL-273) stays one decision in one place. */
function Composer({ onSend }: { onSend: (text: string) => void }) {
  const inputId = useId();
  const [draft, setDraft] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSend(draft);
    setDraft('');
  }

  return (
    <form className="note-composer" onSubmit={submit}>
      <label htmlFor={inputId} className="sr-only">
        Reply to Hale about this note
      </label>
      <input
        id={inputId}
        type="text"
        className="field"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        placeholder="Reply to Hale…"
        autoComplete="off"
        enterKeyHint="send"
      />
      <button type="submit" className="note-composer-send" aria-label="Send reply">
        <Icon as={ArrowUp} size={18} />
      </button>
    </form>
  );
}
