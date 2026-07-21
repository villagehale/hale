'use client';

import type { ToolCard } from '@hale/agent';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { detectInputIntents, type InputIntent } from '~/lib/coach/action-intent';
import type { TimelineMessage } from '~/lib/coach/conversation';
import type { ThreadSeed } from '~/lib/coach/thread';

export type { ToolCard } from '@hale/agent';

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
 * a content-free preview — NEVER tool arguments or raw tool output. The lone
 * exception is a whitelisted `card` a connector read tool attached (see ToolCard).
 */
export type Activity =
  | { kind: 'step'; step: number }
  | { kind: 'tool_call'; name: string }
  | { kind: 'tool_result'; name: string; ok: boolean; preview: string; card?: ToolCard };

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
  | { type: 'tool_result'; name: string; ok: boolean; preview: string; card?: ToolCard }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; conversationId: string; actionIntents?: ActionIntent[] }
  | { type: 'error' };

interface CoachRequest {
  question: string;
  conversationId?: string;
  focusedChildId?: string;
  attachmentIds?: string[];
}

/**
 * The single POST payload for /api/coach. The running conversationId continues the
 * SAME family conversation; the focused child scopes the turn; attachmentIds carry
 * files already uploaded to /api/coach/attachments (B4 — gated off until that route
 * lands, see ATTACHMENTS_ENABLED). Null/empty values are omitted so the first turn
 * opens the conversation and the family default scope is the absence of a child.
 * Pure + exported so the round-trip is unit-tested.
 */
export function buildCoachRequest(
  question: string,
  conversationId: string | null,
  focusedChildId: string | null,
  attachmentIds: string[] = [],
): CoachRequest {
  return {
    question,
    ...(conversationId ? { conversationId } : {}),
    ...(focusedChildId ? { focusedChildId } : {}),
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
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

/**
 * Maps a conversation's persisted timeline into the client Turn shape — the same
 * mapping the server-rehydrated seed and a reopened session (GET
 * /api/coach/conversations/:id) both use, so history looks identical however it was
 * loaded. Historical turns carry no live stream metadata (activity/intents), so a
 * reopened answer renders as a settled plain answer. Pure + exported for unit test.
 */
export function timelineToTurns(timeline: TimelineMessage[]): Turn[] {
  return timeline.map((m) => ({
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

/**
 * The turn ids a parent may delete: every turn EXCEPT those minted in THIS browser
 * session. A just-sent turn holds a client-generated id, not the persisted server
 * message id, so an audited delete would 404 — it stays non-deletable until a reload
 * rehydrates it with its real id. Seeded AND reopened-conversation turns both carry
 * real server ids, so both are deletable (the reopen case a seed-only set missed).
 * Pure + exported so the rule is unit-tested.
 */
export function deletableTurnIds(
  turns: Turn[],
  sessionCreatedIds: ReadonlySet<string>,
): Set<string> {
  return new Set(turns.filter((t) => !sessionCreatedIds.has(t.id)).map((t) => t.id));
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
  /** Sends a turn on the active conversation. `attachmentIds` ride the send when the
   * attachments feature is on (B4); an attachments-only send is allowed. */
  ask: (question: string, attachmentIds?: string[]) => Promise<void>;
  /** The conversation the rail highlights as active (null = an unsaved new chat, no
   * row until the first send opens it). */
  activeConversationId: string | null;
  /** Clears the transcript to an unsaved new chat — the next send opens a fresh
   * conversation (rule: /api/coach with no conversationId creates one). */
  newChat: () => void;
  /** Reopens a past session: loads its transcript (family-scoped, rule #1) and
   * continues it. Returns false when the fetch failed or the thread isn't the
   * family's. */
  openConversation: (id: string) => Promise<boolean>;
  /** Bumps whenever the conversation SET could have changed (a send opened/continued
   * a thread) so the session rail refetches its list. */
  historyRevision: number;
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
  /** The turn ids the per-turn delete affordance is offered on — persisted turns
   * (seeded OR reopened), never this-session sends (their client id would 404). */
  deletableIds: ReadonlySet<string>;
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
  initialDraft = '',
): UseAskHale {
  const [turns, setTurns] = useState<Turn[]>(() => timelineToTurns(seed.timeline));
  const [conversationId, setConversationId] = useState<string | null>(seed.conversationId);
  // Seeded from the Home ask bar's `q` so a question typed there lands in the composer
  // (ready to send) instead of being dropped on navigation (WEB-02).
  const [draft, setDraft] = useState(initialDraft);
  const [status, setStatus] = useState<AskStatus>('idle');
  // The id of the assistant turn currently being streamed into, or null before the
  // first token (typing indicator) and after the stream ends.
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [focusedChildId, setFocusedChildId] = useState<string | null>(initialFocusedChildId);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  // Ids minted by THIS session's sends (client uuids, not persisted server ids yet).
  // Everything else in `turns` — seeded or reopened — is a real server row, so
  // deletableTurnIds offers per-turn delete on it (never on a just-sent turn).
  const sessionCreatedIds = useRef<Set<string>>(new Set());
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

  async function ask(question: string, attachmentIds: string[] = []): Promise<void> {
    const trimmed = question.trim();
    // A send needs either text or (when the feature is on) at least one attachment;
    // never two in flight at once.
    if ((!trimmed && attachmentIds.length === 0) || status === 'pending') return;
    setStatus('pending');
    setStreamingId(null);
    const scopedChild = focusedChildId;
    // Deterministic, regex-only detection of a command in the parent's OWN
    // instruction (no LLM on the hot path — rule #2). A match surfaces a confirm
    // widget under the user turn; a miss is the common case and adds nothing.
    const inputIntents = detectInputIntents(trimmed);
    const userTurnId = crypto.randomUUID();
    sessionCreatedIds.current.add(userTurnId);
    setTurns((prev) => [
      ...prev,
      {
        id: userTurnId,
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
      sessionCreatedIds.current.add(id);
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
        body: JSON.stringify(buildCoachRequest(trimmed, conversationId, scopedChild, attachmentIds)),
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
            ...(event.card ? { card: event.card } : {}),
          });
        } else if (event.type === 'reset') {
          resetAssistantTurn();
        } else if (event.type === 'done') {
          setConversationId(event.conversationId);
          // The send opened a new thread or continued one → its last-active stamp
          // moved, so the session rail should refetch to re-sort/insert the row.
          setHistoryRevision((r) => r + 1);
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

  // Clear to an unsaved new chat. The next send opens a fresh conversation server-side
  // (/api/coach with no conversationId → createConversation), so this is a pure
  // client reset — nothing is written until the parent actually sends.
  const newChat = useCallback(() => {
    setTurns([]);
    setConversationId(null);
    setStreamingId(null);
    setStatus('idle');
    setFocusedChildId(null);
    setTopicFilter(null);
    setSearch('');
    setDraft('');
    sessionCreatedIds.current = new Set();
    inputRef.current?.focus();
  }, []);

  // Reopen a past session: load its transcript (family-scoped inside the route, rule
  // #1) and continue it. A no-op when it's already the active thread or a send is in
  // flight. Filters reset so the reopened conversation reads from the top.
  const openConversation = useCallback(
    async (id: string): Promise<boolean> => {
      if (id === conversationId || status === 'pending') return true;
      try {
        const res = await fetch(`/api/coach/conversations/${id}`);
        if (!res.ok) return false;
        const data = (await res.json()) as { conversationId: string; turns: TimelineMessage[] };
        // The reopened turns are all persisted server rows, so none are "session-
        // created" — clearing the set makes every reopened turn deletable.
        sessionCreatedIds.current = new Set();
        setTurns(timelineToTurns(data.turns));
        setConversationId(data.conversationId);
        setStreamingId(null);
        setStatus('idle');
        setFocusedChildId(null);
        setTopicFilter(null);
        setSearch('');
        return true;
      } catch {
        return false;
      }
    },
    [conversationId, status],
  );

  async function deleteTurn(id: string): Promise<boolean> {
    try {
      const res = await fetch('/api/coach/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: id }),
      });
      if (res.status !== 200) return false;
      setTurns((prev) => prev.filter((t) => t.id !== id));
      // The conversation's content changed (its preview / count / possibly its
      // emptiness) — nudge the session rail to refetch so the row reflects it.
      setHistoryRevision((r) => r + 1);
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
      // The conversation was erased — the session rail must refetch to drop/retitle
      // its row rather than keep showing a stale entry.
      setHistoryRevision((r) => r + 1);
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
    activeConversationId: conversationId,
    newChat,
    openConversation,
    historyRevision,
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
    // Recomputed each render (cheap; sets are tiny). The ref holds this session's
    // sends, so seeded + reopened turns are deletable and just-sent ones are not.
    deletableIds: deletableTurnIds(turns, sessionCreatedIds.current),
  };
}
