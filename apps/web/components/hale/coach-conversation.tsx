'use client';

import { useState } from 'react';
import { Folio } from '~/components/hale/folio';

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

/**
 * The interactive Ask Hale thread — now multi-turn. Each question POSTs to
 * /api/coach carrying the running conversationId, so the agent keeps context
 * across turns; the response's conversationId is held and re-sent. The full
 * thread (your questions + Hale's answers) renders in the Meadow editorial style.
 * Honest UX: a pending row while the agent works, the error surfaced in place. In
 * dev preview (auth unconfigured) the input is replaced with a "sign in" notice
 * and no request is ever sent — so no spend.
 */
export function CoachConversation({ canAsk }: { canAsk: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  async function ask() {
    const question = draft.trim();
    if (!question || status === 'pending') return;
    setStatus('pending');
    setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', body: question }]);
    setDraft('');
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationId ? { question, conversationId } : { question }),
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

  return (
    <>
      <section>
        {turns.map((turn, idx) =>
          turn.role === 'user' ? (
            <article key={turn.id} className="py-10 border-t border-rule first:border-t-0">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-4 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx + 1} />
                  <p className="eyebrow text-spruce mt-2">you</p>
                </div>
                <div className="md:col-span-10">
                  <p className="font-display text-[1.5rem] lg:text-[1.85rem] leading-snug">
                    &ldquo;{turn.body}&rdquo;
                  </p>
                </div>
              </div>
            </article>
          ) : (
            <article key={turn.id} className="py-10 border-t border-rule">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx + 1} />
                  <p className="eyebrow text-apricot-deep mt-2">Hale</p>
                </div>
                <div className="md:col-span-10 space-y-6">
                  <p className="text-lg text-spruce leading-relaxed">{turn.body}</p>
                </div>
              </div>
            </article>
          ),
        )}

        {status === 'pending' ? (
          <article className="py-10 border-t border-rule">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-y-4 md:gap-x-8">
              <div className="md:col-span-2">
                <p className="eyebrow text-apricot-deep">Hale</p>
              </div>
              <div className="md:col-span-10">
                <p className="meta italic" aria-live="polite">
                  thinking it through…
                </p>
              </div>
            </div>
          </article>
        ) : null}
      </section>

      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">ask Hale</span>
            <p className="meta mt-2">type your question</p>
          </div>
          <div className="lg:col-span-9 space-y-6">
            {canAsk ? (
              <>
                <label htmlFor="coach-input" className="sr-only">
                  ask Hale
                </label>
                <textarea
                  id="coach-input"
                  name="question"
                  rows={3}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="what tends to happen at five months? do we need to start solids yet?"
                  className="field"
                  autoComplete="off"
                />
                <div className="flex flex-wrap items-center justify-end gap-y-4 gap-x-6">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={ask}
                    disabled={status === 'pending' || draft.trim().length === 0}
                    aria-live="polite"
                  >
                    {status === 'pending' ? 'thinking…' : 'ask →'}
                  </button>
                </div>
                {status === 'error' ? (
                  <p className="meta italic text-apricot-deep" role="alert">
                    something went wrong reaching Hale — please try again.
                  </p>
                ) : null}
                <p className="meta">
                  your conversation stays inside Hale. Hale never sees your inbox or
                  calendar — and never another family&rsquo;s data.
                </p>
              </>
            ) : (
              <output className="dev-preview-banner">
                Sign in to ask Hale. In development preview (auth not configured)
                the thread is read-only — no question is sent and no model is
                called.
              </output>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
