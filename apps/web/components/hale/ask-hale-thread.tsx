'use client';

import { useId } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Folio } from '~/components/hale/folio';
import { Markdown } from '~/components/hale/markdown';
import { type UseAskHale, useAskHale } from '~/components/hale/use-ask-hale';
import type { ThreadSeed } from '~/lib/coach/thread';

export type AskHaleVariant = 'compact' | 'full';

interface AskHaleThreadProps {
  /** Whether the signed-in parent may spend (auth configured). */
  canAsk: boolean;
  /** Server-rehydrated thread — seeds history + the running conversationId. */
  seed: ThreadSeed;
  /** 'compact' = Home hero entry; 'full' = the /coach editorial thread. */
  variant: AskHaleVariant;
}

const EXAMPLE_PROMPTS = [
  'when do I start solids?',
  'find a daycare near me',
  "what's good this weekend?",
] as const;

/** Disabled-state affordance for pills/buttons — globals.css carries no :disabled. */
const DISABLED_AFFORDANCE = 'disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The ONE Ask Hale conversation surface, shared by every page. Both the Home hero
 * (compact) and the full /coach thread (full) render through this component and
 * the single `useAskHale` hook, so they share one source of state and one set of
 * behaviours: rehydrated history, a round-tripped conversationId, auto-scroll to
 * the newest turn, focus returned to the input after a send. In dev preview (auth
 * unconfigured) the composer is replaced with a "sign in" notice — no request is
 * ever sent, so no spend.
 */
export function AskHaleThread({ canAsk, seed, variant }: AskHaleThreadProps) {
  const chat = useAskHale(seed);
  return variant === 'compact' ? (
    <CompactSurface canAsk={canAsk} chat={chat} />
  ) : (
    <FullSurface canAsk={canAsk} chat={chat} />
  );
}

function CompactSurface({ canAsk, chat }: { canAsk: boolean; chat: UseAskHale }) {
  const inputId = useId();
  const { turns, status, draft, setDraft, ask, inputRef, threadEndRef } = chat;

  if (!canAsk) {
    return (
      <div className="panel space-y-4">
        <p className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
          ask Hale anything.
        </p>
        <output className="dev-preview-banner">
          Sign in to ask Hale. In development preview (auth not configured) the ask
          box is read-only — no question is sent and no model is called.
        </output>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="field-group">
        <label
          htmlFor={inputId}
          className="font-display text-[1.75rem] lg:text-[2.5rem] leading-tight"
        >
          ask Hale anything.
        </label>
        <textarea
          ref={inputRef}
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
            className={`pill-action cursor-pointer ${DISABLED_AFFORDANCE}`}
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
        >
          {status === 'pending' ? 'thinking…' : 'ask Hale'}
        </Button>
      </div>

      {status === 'error' ? (
        <p className="meta italic text-apricot-deep" role="alert">
          Couldn&rsquo;t reach Hale — try again in a moment.
        </p>
      ) : null}

      {turns.length > 0 ? (
        <div className="space-y-5 rise rise-1" aria-live="polite">
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
                <Markdown>{turn.body}</Markdown>
              </article>
            ),
          )}
          <div ref={threadEndRef} />
        </div>
      ) : null}
    </div>
  );
}

function FullSurface({ canAsk, chat }: { canAsk: boolean; chat: UseAskHale }) {
  const { turns, status, draft, setDraft, ask, inputRef, threadEndRef } = chat;

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
                  <Markdown>{turn.body}</Markdown>
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
        <div ref={threadEndRef} />
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
                  ref={inputRef}
                  id="coach-input"
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
                  placeholder="what tends to happen at five months? do we need to start solids yet?"
                  className="field"
                  autoComplete="off"
                />
                <div className="flex flex-wrap items-center justify-end gap-y-4 gap-x-6">
                  <button
                    type="button"
                    className={`btn-primary ${DISABLED_AFFORDANCE}`}
                    onClick={() => ask(draft)}
                    disabled={status === 'pending' || draft.trim().length === 0}
                    aria-live="polite"
                  >
                    {status === 'pending' ? 'thinking…' : 'ask →'}
                  </button>
                </div>
                {status === 'error' ? (
                  <p className="meta italic text-apricot-deep" role="alert">
                    Couldn&rsquo;t reach Hale — try again in a moment.
                  </p>
                ) : null}
                <p className="meta">
                  your conversation stays inside Hale. Hale never sees your inbox or
                  calendar — and never another family&rsquo;s data.
                </p>
              </>
            ) : (
              <output className="dev-preview-banner">
                Sign in to ask Hale. In development preview (auth not configured) the
                thread is read-only — no question is sent and no model is called.
              </output>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
