'use client';

import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '~/components/ui/button';
import type { CoachAnswerView } from '~/lib/coach/view';

type Status = 'idle' | 'pending' | 'error';

const EXAMPLE_PROMPTS = [
  'when do I start solids?',
  'find a daycare near me',
  "what's good this weekend?",
] as const;

/**
 * The Home hero: a parent asks Hale anything. POSTs the question to /api/coach
 * and renders the grounded answer inline. Honest UX — a pending state while the
 * model thinks, the error surfaced in place (never a silent success). In dev
 * preview (auth unconfigured) the input is replaced with a "sign in" notice and
 * no request is ever sent, so no spend.
 */
export function AskBox({ canAsk }: { canAsk: boolean }) {
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [answer, setAnswer] = useState<{ question: string; view: CoachAnswerView } | null>(null);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || status === 'pending') return;
    setStatus('pending');
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const view = (await res.json()) as CoachAnswerView;
      setAnswer({ question: trimmed, view });
      setDraft('');
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
          Sign in to ask Hale. In development preview (Google OAuth not configured) the
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
            onClick={() => {
              setDraft(prompt);
              ask(prompt);
            }}
            disabled={status === 'pending'}
          >
            {prompt}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-6">
        <p className="meta">
          your question stays inside Hale — only your family&rsquo;s stage is shared.
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

      {answer ? (
        <article className="panel space-y-5 rise rise-1">
          <p className="font-display text-[1.35rem] lg:text-[1.6rem] leading-snug">
            &ldquo;{answer.question}&rdquo;
          </p>
          <p className="text-lg text-spruce leading-relaxed">{answer.view.body}</p>

          {answer.view.flagForPediatrician ? (
            <p className="meta italic text-apricot-deep">
              this touches on something medical — please check with your pediatric office.
            </p>
          ) : null}

          {answer.view.citations.length > 0 ? (
            <div className="border-l-2 border-apricot-deep pl-5">
              <span className="eyebrow text-spruce">grounded in</span>
              <ul className="mt-2 space-y-1.5">
                {answer.view.citations.map((c) => (
                  <li key={c} className="meta italic">
                    — {c}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {answer.view.followUps.length > 0 ? (
            <div>
              <span className="eyebrow">i might also ask</span>
              <ul className="mt-3 space-y-2">
                {answer.view.followUps.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      className="link text-lg text-spruce text-left cursor-pointer"
                      onClick={() => {
                        setDraft(q);
                        ask(q);
                      }}
                    >
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </article>
      ) : null}
    </div>
  );
}
