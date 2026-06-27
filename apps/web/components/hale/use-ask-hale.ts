'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import type { ThreadSeed } from '~/lib/coach/thread';

export type AskStatus = 'idle' | 'pending' | 'error';

/** A gated action chip the answer implied — a DRAFT, never an auto-action (rule #4). */
export interface ActionIntent {
  kind: string;
  label: string;
  actionType: string;
}

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  /** Which child the turn was focused on, or null for the whole family. */
  childId: string | null;
  /** Coarse topic tag for filtering, or null when untagged. */
  topic: string | null;
  /** Gated action chips on an assistant turn (only on the just-received answer). */
  actionIntents?: ActionIntent[];
}

/**
 * One newline-delimited event from POST /api/coach. `delta` carries the next slice
 * of the streamed answer; `reset` means the text streamed so far was an intermediate
 * tool turn, not the answer — clear the in-flight bubble; `done` ends the stream with
 * the running conversationId and the gated action chips; `error` signals a failed run.
 */
type CoachStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; conversationId: string; actionIntents?: ActionIntent[] }
  | { type: 'error' };

interface CoachRequest {
  question: string;
  conversationId?: string;
  focusedChildId?: string;
}

/**
 * The single POST payload for /api/coach. The running conversationId continues the
 * SAME family conversation; the focused child scopes the turn. Null values are
 * omitted so the first turn opens the conversation and the family default scope is
 * the absence of a child. Pure + exported so the round-trip is unit-tested.
 */
export function buildCoachRequest(
  question: string,
  conversationId: string | null,
  focusedChildId: string | null,
): CoachRequest {
  return {
    question,
    ...(conversationId ? { conversationId } : {}),
    ...(focusedChildId ? { focusedChildId } : {}),
  };
}

/**
 * Read a newline-delimited-JSON stream, invoking `onEvent` for each complete line
 * as it arrives. Buffers across chunk boundaries (a line may split mid-chunk) and
 * flushes a trailing unterminated line at end. Exported so the parse is unit-tested.
 */
export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: CoachStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) onEvent(JSON.parse(trimmed) as CoachStreamEvent);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      flushLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  flushLine(buffer);
}

function seedTurns(seed: ThreadSeed): Turn[] {
  return seed.timeline.map((m) => ({
    id: m.id,
    role: m.role,
    body: m.content,
    childId: m.childId,
    topic: m.topic,
  }));
}

/**
 * Filter the timeline by focused child and topic. A null focus shows the whole
 * family (every turn); a focused child shows only that child's turns (and any
 * family-wide turns stay out so the view is truly that child's history). A null
 * topic filter shows every topic. Pure + exported so filtering is unit-tested.
 */
export function filterTurns(
  turns: Turn[],
  focusedChildId: string | null,
  topic: string | null,
  query: string,
): Turn[] {
  const q = query.trim().toLowerCase();
  return turns.filter((t) => {
    if (focusedChildId !== null && t.childId !== focusedChildId) return false;
    if (topic !== null && t.topic !== topic) return false;
    if (q && !t.body.toLowerCase().includes(q)) return false;
    return true;
  });
}

export interface UseAskHale {
  /** Every turn (unfiltered) — the full relationship history. */
  turns: Turn[];
  /** Turns after the active child + topic + search filters. */
  visibleTurns: Turn[];
  status: AskStatus;
  /** The id of the assistant turn currently streaming, or null (pre-first-token / idle). */
  streamingId: string | null;
  draft: string;
  setDraft: (value: string) => void;
  ask: (question: string) => Promise<void>;
  /** The child the conversation is scoped to (null = whole family). */
  focusedChildId: string | null;
  setFocusedChildId: (id: string | null) => void;
  /** The active topic filter (null = all topics). */
  topicFilter: string | null;
  setTopicFilter: (topic: string | null) => void;
  /** The timeline search query. */
  search: string;
  setSearch: (q: string) => void;
  /** Topics present in the history, for the filter chips. */
  topicsInUse: string[];
  /** Attach to the textarea so focus returns to it after a send. */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Attach to the end-of-thread sentinel so the newest turn scrolls into view. */
  threadEndRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Single source of Ask Hale state for the continuous-companion shell. Seeded from
 * the server-rehydrated timeline (so the one ongoing conversation survives a
 * refresh), it owns the running conversationId, the focused child, the topic +
 * search filters, auto-scrolls to the newest turn, and restores focus to the input
 * after each send. Filtering is derived, not stored, so the full history is always
 * intact behind any filter.
 */
export function useAskHale(
  seed: ThreadSeed,
  initialFocusedChildId: string | null = null,
): UseAskHale {
  const [turns, setTurns] = useState<Turn[]>(() => seedTurns(seed));
  const [conversationId, setConversationId] = useState<string | null>(seed.conversationId);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<AskStatus>('idle');
  // The id of the assistant turn currently being streamed into, or null before the
  // first token (typing indicator) and after the stream ends.
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [focusedChildId, setFocusedChildId] = useState<string | null>(initialFocusedChildId);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const capture = useAnalytics();

  const visibleTurns = useMemo(
    () => filterTurns(turns, focusedChildId, topicFilter, search),
    [turns, focusedChildId, topicFilter, search],
  );

  const topicsInUse = useMemo(() => {
    const seen = new Set<string>();
    for (const t of turns) {
      if (t.topic) seen.add(t.topic);
    }
    return [...seen];
  }, [turns]);

  // Scroll to the latest turn after a NEW message — but never on initial mount.
  // On mount the thread hydrates with the existing history, and scrollIntoView
  // there drags the whole .main-stage page down to the conversation's end, so home
  // and coach opened scrolled past their header. Skip the first run; only follow
  // turns the user actually adds in this session.
  const didHydrate = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleTurns is the intended trigger, not a value read in the body
  useEffect(() => {
    if (!didHydrate.current) {
      didHydrate.current = true;
      return;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    threadEndRef.current?.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'end',
    });
  }, [visibleTurns]);

  async function ask(question: string): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed || status === 'pending') return;
    setStatus('pending');
    setStreamingId(null);
    const scopedChild = focusedChildId;
    setTurns((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', body: trimmed, childId: scopedChild, topic: null },
    ]);
    setDraft('');
    capture('ask_hale', { scoped: scopedChild !== null });

    // The assistant turn the stream appends into. Created lazily on the first delta
    // so the typing indicator shows until the first token, then the bubble grows.
    let assistantId: string | null = null;
    const ensureAssistantTurn = (): string => {
      if (assistantId) return assistantId;
      const id = crypto.randomUUID();
      assistantId = id;
      setStreamingId(id);
      setTurns((prev) => [
        ...prev,
        { id, role: 'assistant', body: '', childId: scopedChild, topic: null, actionIntents: [] },
      ]);
      return id;
    };
    const appendDelta = (text: string) => {
      const id = ensureAssistantTurn();
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, body: t.body + text } : t)));
    };
    // An intermediate tool turn streamed text that is NOT the answer — clear it so
    // only the final answer renders, and fall back to the typing indicator.
    const resetAssistantTurn = () => {
      if (!assistantId) return;
      const id = assistantId;
      setTurns((prev) => prev.filter((t) => t.id !== id));
      assistantId = null;
      setStreamingId(null);
    };

    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildCoachRequest(trimmed, conversationId, scopedChild)),
      });
      // Over the silent guard: render a calm, in-thread aside (NOT the error
      // state) so a burst reads as Hale pausing, never as a failure or a wall.
      if (res.status === 429) {
        const id = ensureAssistantTurn();
        setStreamingId(null);
        setTurns((prev) =>
          prev.map((t) =>
            t.id === id ? { ...t, body: 'Just a moment — try that again in a few seconds.' } : t,
          ),
        );
        setStatus('idle');
        return;
      }
      if (!res.ok || !res.body) {
        setStatus('error');
        return;
      }

      let failed = false;
      await readNdjson(res.body, (event) => {
        if (event.type === 'delta') {
          appendDelta(event.text);
        } else if (event.type === 'reset') {
          resetAssistantTurn();
        } else if (event.type === 'done') {
          setConversationId(event.conversationId);
          const id = ensureAssistantTurn();
          setStreamingId(null);
          setTurns((prev) =>
            prev.map((t) => (t.id === id ? { ...t, actionIntents: event.actionIntents ?? [] } : t)),
          );
        } else {
          failed = true;
        }
      });

      if (failed) {
        resetAssistantTurn();
        setStatus('error');
        return;
      }
      setStatus('idle');
    } catch {
      resetAssistantTurn();
      setStatus('error');
    } finally {
      inputRef.current?.focus();
    }
  }

  return {
    turns,
    visibleTurns,
    status,
    streamingId,
    draft,
    setDraft,
    ask,
    focusedChildId,
    setFocusedChildId,
    topicFilter,
    setTopicFilter,
    search,
    setSearch,
    topicsInUse,
    inputRef,
    threadEndRef,
  };
}
