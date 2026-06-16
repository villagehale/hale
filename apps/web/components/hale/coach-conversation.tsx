'use client';

import { useState } from 'react';
import { Folio } from '~/components/hale/folio';
import type { CoachAnswerView } from '~/lib/coach/view';

type Status = 'idle' | 'pending' | 'error';

interface Exchange {
  id: string;
  question: string;
  answer: CoachAnswerView;
}

/**
 * The interactive coach. POSTs the parent's question to /api/coach and renders
 * the grounded answer in the Meadow editorial style. Honest UX: a pending row
 * while the model is thinking, the error surfaced in place (never a silent
 * success). In dev preview (Clerk unconfigured) the input is replaced with a
 * "sign in to ask" notice and no request is ever sent — so no spend.
 */
export function CoachConversation({ canAsk }: { canAsk: boolean }) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  async function ask() {
    const question = draft.trim();
    if (!question || status === 'pending') return;
    setStatus('pending');
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const answer = (await res.json()) as CoachAnswerView;
      setExchanges((prev) => [...prev, { id: crypto.randomUUID(), question, answer }]);
      setDraft('');
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }

  return (
    <>
      <section>
        {exchanges.map((entry, idx) => (
          <div key={entry.id}>
            <article className="py-10 border-t border-rule first:border-t-0">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-4 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx * 2 + 1} />
                  <p className="eyebrow text-spruce mt-2">you</p>
                </div>
                <div className="md:col-span-10">
                  <p className="font-display text-[1.5rem] lg:text-[1.85rem] leading-snug">
                    &ldquo;{entry.question}&rdquo;
                  </p>
                </div>
              </div>
            </article>

            <article className="py-10 border-t border-rule">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx * 2 + 2} />
                  <p className="eyebrow text-apricot-deep mt-2">Hale</p>
                  <p className="meta mt-1">
                    confidence · {entry.answer.confidence.toFixed(2)}
                  </p>
                </div>
                <div className="md:col-span-10 space-y-6">
                  <p className="text-lg text-spruce leading-relaxed">{entry.answer.body}</p>

                  {entry.answer.flagForPediatrician ? (
                    <p className="meta italic text-apricot-deep">
                      this touches on something medical — please check with your
                      pediatric office.
                    </p>
                  ) : null}

                  {entry.answer.citations.length > 0 ? (
                    <div className="border-l-2 border-apricot-deep pl-5">
                      <span className="eyebrow text-spruce">grounded in</span>
                      <ul className="mt-2 space-y-1.5">
                        {entry.answer.citations.map((c) => (
                          <li key={c} className="meta italic">
                            — {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {entry.answer.followUps.length > 0 ? (
                    <div>
                      <span className="eyebrow">i might also ask</span>
                      <ul className="mt-3 space-y-2">
                        {entry.answer.followUps.map((q) => (
                          <li key={q}>
                            <button
                              type="button"
                              className="link text-lg text-spruce text-left"
                              onClick={() => setDraft(q)}
                            >
                              {q}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          </div>
        ))}

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
            <span className="eyebrow">ask coach</span>
            <p className="meta mt-2">type your question</p>
          </div>
          <div className="lg:col-span-9 space-y-6">
            {canAsk ? (
              <>
                <label htmlFor="coach-input" className="sr-only">
                  ask coach
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
                    something went wrong reaching the coach — please try again.
                  </p>
                ) : null}
                <p className="meta">
                  your question stays inside Hale. coach never sees your inbox or
                  calendar — only your family&rsquo;s stage.
                </p>
              </>
            ) : (
              <output className="dev-preview-banner">
                Sign in to ask the coach. In development preview (Clerk not
                configured) the coach is read-only — no question is sent and no
                model is called.
              </output>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
