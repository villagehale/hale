'use client';

import { useEffect, useRef, useState } from 'react';
import type { ThreadSeed } from '~/lib/coach/thread';

export type AskStatus = 'idle' | 'pending' | 'error';

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  body: string;
}

interface CoachResponse {
  body: string;
  conversationId: string;
}

interface CoachRequest {
  question: string;
  conversationId?: string;
}

/**
 * The single POST payload for /api/coach. The running conversationId is carried
 * forward so every turn continues the SAME thread (the agent re-reads its
 * transcript); a null id is omitted so the first turn opens a fresh conversation.
 * Pure + exported so the conversationId round-trip is unit-tested without a fetch.
 */
export function buildCoachRequest(question: string, conversationId: string | null): CoachRequest {
  return conversationId ? { question, conversationId } : { question };
}

function seedTurns(seed: ThreadSeed): Turn[] {
  return seed.messages.map((m) => ({
    id: crypto.randomUUID(),
    role: m.role,
    body: m.content,
  }));
}

export interface UseAskHale {
  turns: Turn[];
  status: AskStatus;
  draft: string;
  setDraft: (value: string) => void;
  ask: (question: string) => Promise<void>;
  /** Attach to the textarea so focus returns to it after a send. */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Attach to the end-of-thread sentinel so the newest turn scrolls into view. */
  threadEndRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Single source of Ask Hale conversation state, shared by every surface (the Home
 * hero and the full /coach thread). Seeded from the server-rehydrated thread so
 * visible history survives a refresh, it owns the running conversationId (round-
 * tripped through /api/coach), auto-scrolls to the newest turn, and restores focus
 * to the input after each send.
 */
export function useAskHale(seed: ThreadSeed): UseAskHale {
  const [turns, setTurns] = useState<Turn[]>(() => seedTurns(seed));
  const [conversationId, setConversationId] = useState<string | null>(seed.conversationId);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<AskStatus>('idle');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: turns is the intended trigger, not a value read in the body
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  async function ask(question: string): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed || status === 'pending') return;
    setStatus('pending');
    setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', body: trimmed }]);
    setDraft('');
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildCoachRequest(trimmed, conversationId)),
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const answer = (await res.json()) as CoachResponse;
      setConversationId(answer.conversationId);
      setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', body: answer.body }]);
      setStatus('idle');
    } catch {
      setStatus('error');
    } finally {
      inputRef.current?.focus();
    }
  }

  return { turns, status, draft, setDraft, ask, inputRef, threadEndRef };
}
