'use client';

import { useId } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { ActionChip } from '~/components/hale/action-chip';
import { Markdown } from '~/components/hale/markdown';
import { type Turn, type UseAskHale, useAskHale } from '~/components/hale/use-ask-hale';
import type { SuggestionGroup, TimelineChild, ThreadSeed } from '~/lib/coach/thread';

export type AskHaleVariant = 'compact' | 'full';

interface AskHaleThreadProps {
  /** Whether the signed-in parent may spend (auth configured). */
  canAsk: boolean;
  /** Server-rehydrated shell — the one conversation's timeline + chips + suggestions. */
  seed: ThreadSeed;
  /** 'compact' = Home hero entry; 'full' = the /coach continuous timeline. */
  variant: AskHaleVariant;
  /** Pre-scope the conversation to a child (contextual entry), or null for the family. */
  initialFocusedChildId?: string | null;
}

/** Disabled-state affordance for pills/buttons — globals.css carries no :disabled. */
const DISABLED_AFFORDANCE = 'disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The ONE Ask Hale conversation surface — a continuous, memory-backed companion,
 * not threads. Both the Home hero (compact) and the full /coach timeline (full)
 * render through this component and the single `useAskHale` hook, so they open the
 * SAME ongoing conversation: shared history, a round-tripped conversationId, a
 * focused-child scope, topic + search filters, auto-scroll, focus-after-send. In
 * dev preview (auth unconfigured) the composer is replaced with a sign-in notice —
 * no request is sent, so no spend.
 *
 * Mobile-first: the timeline reads comfortably at 375px — a single column with a
 * bounded line-length, message grouping (the scope chip shows once per turn), and
 * a sticky composer at the bottom so the next action is always in reach.
 */
export function AskHaleThread({
  canAsk,
  seed,
  variant,
  initialFocusedChildId = null,
}: AskHaleThreadProps) {
  const chat = useAskHale(seed, initialFocusedChildId);
  return variant === 'compact' ? (
    <CompactSurface canAsk={canAsk} chat={chat} seed={seed} />
  ) : (
    <FullSurface canAsk={canAsk} chat={chat} seed={seed} />
  );
}

/** The child chips + family default — the per-child scope selector. */
function ScopeChips({
  kids,
  focusedChildId,
  setFocusedChildId,
}: {
  kids: TimelineChild[];
  focusedChildId: string | null;
  setFocusedChildId: (id: string | null) => void;
}) {
  if (kids.length === 0) return null;
  return (
    <fieldset
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
      aria-label="who is this about"
    >
      <ScopeChip active={focusedChildId === null} onClick={() => setFocusedChildId(null)}>
        whole family
      </ScopeChip>
      {kids.map((child) => (
        <ScopeChip
          key={child.id}
          active={focusedChildId === child.id}
          onClick={() => setFocusedChildId(child.id)}
        >
          {child.label ?? 'your teen'}
        </ScopeChip>
      ))}
    </fieldset>
  );
}

function ScopeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`pill pill-action cursor-pointer ${active ? 'pill-apricot' : ''}`}
    >
      {children}
    </button>
  );
}

/** The stage-aware suggestion chips for the active scope (feature 3). */
function Suggestions({
  suggestions,
  focusedChildId,
  onPick,
  disabled,
}: {
  suggestions: SuggestionGroup[];
  focusedChildId: string | null;
  onPick: (prompt: string) => void;
  disabled: boolean;
}) {
  const group =
    suggestions.find((g) => g.childId === focusedChildId) ??
    suggestions.find((g) => g.childId === null);
  if (!group) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {group.prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          className={`pill pill-action cursor-pointer ${DISABLED_AFFORDANCE}`}
          onClick={() => onPick(prompt)}
          disabled={disabled}
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

/** The topic + search filters over the one continuous timeline. */
function TimelineFilters({
  topicsInUse,
  topicFilter,
  setTopicFilter,
  search,
  setSearch,
}: {
  topicsInUse: string[];
  topicFilter: string | null;
  setTopicFilter: (t: string | null) => void;
  search: string;
  setSearch: (q: string) => void;
}) {
  const searchId = useId();
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          aria-hidden
          size={16}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faded-sage"
        />
        <label htmlFor={searchId} className="sr-only">
          search this conversation
        </label>
        <input
          id={searchId}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search this conversation"
          className="field pl-10"
          autoComplete="off"
        />
      </div>
      {topicsInUse.length > 0 ? (
        <fieldset
          className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
          aria-label="filter by topic"
        >
          <button
            type="button"
            aria-pressed={topicFilter === null}
            onClick={() => setTopicFilter(null)}
            className={`pill pill-action cursor-pointer ${topicFilter === null ? 'pill-sky' : ''}`}
          >
            all topics
          </button>
          {topicsInUse.map((topic) => (
            <button
              key={topic}
              type="button"
              aria-pressed={topicFilter === topic}
              onClick={() => setTopicFilter(topic)}
              className={`pill pill-action cursor-pointer ${topicFilter === topic ? 'pill-sky' : ''}`}
            >
              {topic}
            </button>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

/**
 * The grouped timeline of turns. Mobile-first: one column, bounded line-length, a
 * scope chip shown only when the turn's scope CHANGES from the prior turn (message
 * grouping). Assistant turns render markdown + any gated action chips.
 */
function Timeline({
  turns,
  childLabelOf,
  focusedChildId,
}: {
  turns: Turn[];
  childLabelOf: (id: string | null) => string;
  focusedChildId: string | null;
}) {
  let lastScope: string | null | undefined;
  return (
    <div className="space-y-5" aria-live="polite">
      {turns.map((turn) => {
        const scopeKey = `${turn.childId ?? 'family'}`;
        const showScope = scopeKey !== lastScope;
        lastScope = scopeKey;
        return (
          <div key={turn.id} className="space-y-2">
            {showScope ? (
              <p className="eyebrow text-faded-sage">{childLabelOf(turn.childId)}</p>
            ) : null}
            {turn.role === 'user' ? (
              <p className="max-w-prose font-display text-[1.15rem] leading-snug text-spruce">
                &ldquo;{turn.body}&rdquo;
              </p>
            ) : (
              <article className="panel max-w-prose">
                <Markdown>{turn.body}</Markdown>
                {turn.actionIntents && turn.actionIntents.length > 0 ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {turn.actionIntents.map((intent) => (
                      <ActionChip
                        key={intent.kind}
                        intent={intent}
                        focusedChildId={focusedChildId}
                        sourceAnswer={turn.body}
                      />
                    ))}
                  </div>
                ) : null}
              </article>
            )}
          </div>
        );
      })}
    </div>
  );
}

function useChildLabel(children: TimelineChild[]) {
  return (id: string | null): string => {
    if (id === null) return 'whole family';
    const child = children.find((c) => c.id === id);
    return child?.label ?? 'your teen';
  };
}

function ComposerNote() {
  return (
    <p className="meta">
      your conversation stays inside Hale — only your family&rsquo;s context is used. Hale drafts
      actions for your approval; it never acts on its own.
    </p>
  );
}

function CompactSurface({
  canAsk,
  chat,
  seed,
}: {
  canAsk: boolean;
  chat: UseAskHale;
  seed: ThreadSeed;
}) {
  const inputId = useId();
  const {
    visibleTurns,
    status,
    draft,
    setDraft,
    ask,
    focusedChildId,
    setFocusedChildId,
    inputRef,
    threadEndRef,
  } = chat;
  const childLabelOf = useChildLabel(seed.children);

  if (!canAsk) {
    return (
      <div className="panel space-y-4">
        <p className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
          ask Hale anything.
        </p>
        <output className="dev-preview-banner">
          Sign in to ask Hale. In development preview (auth not configured) the ask box is
          read-only — no question is sent and no model is called.
        </output>
      </div>
    );
  }

  return (
    <div className="space-y-5">
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

      <ScopeChips
        kids={seed.children}
        focusedChildId={focusedChildId}
        setFocusedChildId={setFocusedChildId}
      />
      <Suggestions
        suggestions={seed.suggestions}
        focusedChildId={focusedChildId}
        onPick={ask}
        disabled={status === 'pending'}
      />

      <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-6">
        <ComposerNote />
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

      {visibleTurns.length > 0 ? (
        <div className="rise rise-1">
          <Timeline
            turns={visibleTurns}
            childLabelOf={childLabelOf}
            focusedChildId={focusedChildId}
          />
          <div ref={threadEndRef} />
        </div>
      ) : null}
    </div>
  );
}

function FullSurface({ canAsk, chat, seed }: { canAsk: boolean; chat: UseAskHale; seed: ThreadSeed }) {
  const {
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
  } = chat;
  const childLabelOf = useChildLabel(seed.children);

  return (
    <div className="space-y-6">
      {/* Scope + filters — the continuous conversation, narrowed. */}
      <div className="space-y-4">
        <ScopeChips
          kids={seed.children}
          focusedChildId={focusedChildId}
          setFocusedChildId={setFocusedChildId}
        />
        {turns.length > 0 ? (
          <TimelineFilters
            topicsInUse={topicsInUse}
            topicFilter={topicFilter}
            setTopicFilter={setTopicFilter}
            search={search}
            setSearch={setSearch}
          />
        ) : null}
      </div>

      {/* The timeline of this one relationship. */}
      {turns.length === 0 ? (
        <p className="meta">
          this is the start of your conversation with Hale. ask anything — it stays here, grounded
          in your family.
        </p>
      ) : visibleTurns.length === 0 ? (
        <output className="meta italic block">
          nothing here for this filter — clear it to see the rest of your conversation.
        </output>
      ) : (
        <Timeline turns={visibleTurns} childLabelOf={childLabelOf} focusedChildId={focusedChildId} />
      )}

      {status === 'pending' ? (
        <p className="meta italic" aria-live="polite">
          thinking it through…
        </p>
      ) : null}
      <div ref={threadEndRef} />

      {/* Sticky composer — the next action is always in reach (mobile-first). */}
      <div className="sticky bottom-0 -mx-1 bg-linen/95 pt-4 pb-3 backdrop-blur supports-[backdrop-filter]:bg-linen/80">
        {canAsk ? (
          <div className="space-y-3">
            <Suggestions
              suggestions={seed.suggestions}
              focusedChildId={focusedChildId}
              onPick={ask}
              disabled={status === 'pending'}
            />
            <label htmlFor="coach-input" className="sr-only">
              ask Hale
            </label>
            <textarea
              ref={inputRef}
              id="coach-input"
              name="question"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  ask(draft);
                }
              }}
              placeholder="ask about this child, or your whole family…"
              className="field"
              autoComplete="off"
            />
            <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-6">
              <ComposerNote />
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
          </div>
        ) : (
          <output className="dev-preview-banner">
            Sign in to ask Hale. In development preview (auth not configured) the thread is
            read-only — no question is sent and no model is called.
          </output>
        )}
      </div>
    </div>
  );
}
