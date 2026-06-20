'use client';

import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '~/components/ui/button';

type Status = 'idle' | 'pending' | 'error';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  body: string;
}

interface CoachResponse {
  body: string;
  conversationId: string;
}

const EXAMPLE_PROMPTS = [
  'when do I start solids?',
  'find a daycare near me',
  "what's good this weekend?",
] as const;

/**
 * The Home hero: a parent asks Hale anything, now a multi-turn thread. Each
 * question POSTs to /api/coach with the running conversationId, so the agent
 * keeps context across turns; the response's conversationId is held and re-sent.
 * Honest UX — a pending state while the agent works, the error surfaced in place.
 * In dev preview (auth unconfigured) the input is replaced with a "sign in"
 * notice and no request is ever sent, so no spend.
 */
export function AskBox({ canAsk }: { canAsk: boolean }) {
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || status === 'pending') return;
    setStatus('pending');
    setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', body: trimmed }]);
    setDraft('');
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationId ? { question: trimmed, conversationId } : { question: trimmed }),
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const answer = (await res.json()) as CoachResponse;
      setConversationId(answer.conversationId);
      setTurns((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', body: answer.body },
      ]);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }

  if (!canAsk) {
    return (
      <div className="panel space-y-4">
        <p className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
          ask Hale anything.
        </p>
        <output className="dev-preview-banner">
          Sign in to ask Hale. In development preview (auth not configured) the
          ask box is read-only — no question is sent and no model is called.
        </output>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="field-group">
        <label htmlFor={inputId} className="font-display text-[1.75rem] lg:text-[2.5rem] leading-tight">
          ask Hale anything.
        </label>
        <textarea
          id={inputId}
          name="question"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              ask(draft);
            }
          }}
          placeholder="what tends to happen around this age? what should we be doing this week?"
          className="field"
          autoComplete="off"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="pill cursor-pointer"
            onClick={() => ask(prompt)}
            disabled={status === 'pending'}
          >
            {prompt}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-6">
        <p className="meta">
          your conversation stays inside Hale — only your family&rsquo;s context is used.
        </p>
        <Button
          icon={ArrowRight}
          onClick={() => ask(draft)}
          disabled={status === 'pending' || draft.trim().length === 0}
          aria-live="polite"
        >
          {status === 'pending' ? 'thinking…' : 'ask Hale'}
        </Button>
      </div>

      {status === 'error' ? (
        <p className="meta italic text-apricot-deep" role="alert">
          something went wrong reaching Hale — please try again.
        </p>
      ) : null}

      {turns.length > 0 ? (
        <div className="space-y-5 rise rise-1">
          {turns.map((turn) =>
            turn.role === 'user' ? (
              <p
                key={turn.id}
                className="font-display text-[1.35rem] lg:text-[1.6rem] leading-snug"
              >
                &ldquo;{turn.body}&rdquo;
              </p>
            ) : (
              <article key={turn.id} className="panel">
                <p className="text-lg text-spruce leading-relaxed">{turn.body}</p>
              </article>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
