'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { detectInputIntents, type InputIntent } from '~/lib/coach/action-intent';
import type { ThreadSeed } from '~/lib/coach/thread';

export type { InputIntent, PlanLogParse, QuickLogParse } from '~/lib/coach/action-intent';

export type AskStatus = 'idle' | 'pending' | 'error';

/** A gated action chip the answer implied — a DRAFT, never an auto-action (rule #4). */
export interface ActionIntent {
  kind: string;
  label: string;
  actionType: string;
}

/**
 * One entry in an assistant turn's live activity trail. Rule #1: an activity entry
 * carries only what the server streamed — a step number, or a tool name + outcome +
 * a content-free preview — NEVER tool arguments or raw tool output.
 */
export type Activity =
  | { kind: 'step'; step: number }
  | { kind: 'tool_call'; name: string }
  | { kind: 'tool_result'; name: string; ok: boolean; preview: string };

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
  /** Command widgets detected from the parent's OWN instruction (on a user turn). */
  inputIntents?: InputIntent[];
  /** The live step/tool trail streamed while the answer was being produced. */
  activity?: Activity[];
}

/**
 * One newline-delimited event from POST /api/coach. `step` marks a new model round-
 * trip; `tool_call` names a tool the agent is invoking (rule #1: name only, never
 * args); `tool_result` reports its outcome (rule #1: ok + a content-free preview,
 * never raw output); `delta` carries the next slice of the streamed answer; `reset`
 * means the text streamed so far was an intermediate tool turn, not the answer —
 * clear the in-flight bubble; `done` ends the stream with the running conversationId
 * and the gated action chips; `error` signals a failed run.
 */
type CoachStreamEvent =
  | { type: 'step'; step: number }
  | { type: 'tool_call'; name: string }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
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

/** One entry in the Recents rail — a parent question the family can jump back to.
 * There is ONE ongoing conversation per family, so a "task" is a question within
 * it (its user turn), not a separate thread. */
export interface RecentTask {
  /** The user turn's id — the jump anchor. */
  id: string;
  /** The question text, for the rail label. */
  label: string;
  /** The child the question was scoped to, or null for the whole family. */
  childId: string | null;
}

/**
 * The parent questions in the conversation, newest first — the Recents rail. Only
 * user turns become tasks (an assistant turn is the answer, not its own entry); a
 * blank in-flight turn is dropped so the rail never shows an empty task. Pure +
 * exported so the derivation is unit-tested.
 */
export function recentTasks(turns: Turn[]): RecentTask[] {
  const tasks: RecentTask[] = [];
  for (const t of turns) {
    if (t.role !== 'user') continue;
    const label = t.body.trim();
    if (!label) continue;
    tasks.push({ id: t.id, label, childId: t.childId });
  }
  return tasks.reverse();
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
  /** Soft-deletes one persisted turn (rule #6) and drops it from the timeline.
   * Returns false when the turn isn't the family's or the request failed. A turn
   * that hasn't been persisted yet (no server round-trip) can't be deleted. */
  deleteTurn: (id: string) => Promise<boolean>;
  /** Erases the whole conversation: soft-deletes every persisted turn and clears
   * the timeline. Returns false when there is no conversation or the request failed. */
  eraseConversation: () => Promise<boolean>;
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
    // Deterministic, regex-only detection of a command in the parent's OWN
    // instruction (no LLM on the hot path — rule #2). A match surfaces a confirm
    // widget under the user turn; a miss is the common case and adds nothing.
    const inputIntents = detectInputIntents(trimmed);
    setTurns((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'user',
        body: trimmed,
        childId: scopedChild,
        topic: null,
        ...(inputIntents.length > 0 ? { inputIntents } : {}),
      },
    ]);
    setDraft('');
    capture('ask_hale', { scoped: scopedChild !== null });
    capture('first_ask');

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
    // Append one live activity entry (step / tool_call / tool_result) to the turn's
    // trail. Rule #1: the entry is exactly what the server streamed — a step number
    // or a tool name + outcome + content-free preview — never args or raw output.
    const appendActivity = (entry: Activity) => {
      const id = ensureAssistantTurn();
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, activity: [...(t.activity ?? []), entry] } : t)),
      );
    };
    // An intermediate tool turn streamed text that is NOT the answer — clear that
    // reasoning text so only the final answer renders. The activity trail is REAL
    // completed work, so it survives the reset; a turn with no trail is removed so
    // the typing indicator shows again (the original no-tool behaviour).
    const resetAssistantTurn = () => {
      if (!assistantId) return;
      const id = assistantId;
      let kept = false;
      setTurns((prev) =>
        prev.flatMap((t) => {
          if (t.id !== id) return [t];
          if (t.activity && t.activity.length > 0) {
            kept = true;
            return [{ ...t, body: '' }];
          }
          return [];
        }),
      );
      if (!kept) {
        assistantId = null;
        setStreamingId(null);
      }
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
        } else if (event.type === 'step') {
          appendActivity({ kind: 'step', step: event.step });
        } else if (event.type === 'tool_call') {
          appendActivity({ kind: 'tool_call', name: event.name });
        } else if (event.type === 'tool_result') {
          appendActivity({
            kind: 'tool_result',
            name: event.name,
            ok: event.ok,
            preview: event.preview,
          });
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

  async function deleteTurn(id: string): Promise<boolean> {
    try {
      const res = await fetch('/api/coach/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: id }),
      });
      if (res.status !== 200) return false;
      setTurns((prev) => prev.filter((t) => t.id !== id));
      return true;
    } catch {
      return false;
    }
  }

  async function eraseConversation(): Promise<boolean> {
    if (!conversationId) return false;
    try {
      const res = await fetch('/api/coach/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      });
      if (res.status !== 200) return false;
      setTurns([]);
      return true;
    } catch {
      return false;
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
    deleteTurn,
    eraseConversation,
  };
}
