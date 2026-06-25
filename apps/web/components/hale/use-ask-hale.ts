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

interface CoachResponse {
  body: string;
  conversationId: string;
  actionIntents?: ActionIntent[];
}

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleTurns is the intended trigger, not a value read in the body
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [visibleTurns]);

  async function ask(question: string): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed || status === 'pending') return;
    setStatus('pending');
    const scopedChild = focusedChildId;
    setTurns((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', body: trimmed, childId: scopedChild, topic: null },
    ]);
    setDraft('');
    capture('ask_hale', { scoped: scopedChild !== null });
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildCoachRequest(trimmed, conversationId, scopedChild)),
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const answer = (await res.json()) as CoachResponse;
      setConversationId(answer.conversationId);
      setTurns((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          body: answer.body,
          childId: scopedChild,
          topic: null,
          actionIntents: answer.actionIntents ?? [],
        },
      ]);
      setStatus('idle');
    } catch {
      setStatus('error');
    } finally {
      inputRef.current?.focus();
    }
  }

  return {
    turns,
    visibleTurns,
    status,
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
