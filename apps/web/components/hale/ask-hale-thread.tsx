'use client';

import { ArrowRight, ArrowUp, Search, X } from 'lucide-react';
import { useId, useState } from 'react';
import { ActionChip } from '~/components/hale/action-chip';
import { Markdown } from '~/components/hale/markdown';
import {
  type AskStatus,
  type Turn,
  type UseAskHale,
  useAskHale,
} from '~/components/hale/use-ask-hale';
import { Button } from '~/components/ui/button';
import type { SuggestionGroup, ThreadSeed, TimelineChild } from '~/lib/coach/thread';

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
  align = 'start',
}: {
  suggestions: SuggestionGroup[];
  focusedChildId: string | null;
  onPick: (prompt: string) => void;
  disabled: boolean;
  align?: 'start' | 'center';
}) {
  const group =
    suggestions.find((g) => g.childId === focusedChildId) ??
    suggestions.find((g) => g.childId === null);
  if (!group) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-2 ${align === 'center' ? 'justify-center' : ''}`}
    >
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

/**
 * The quiet conversation header: the per-child scope on the left, a secondary
 * search affordance on the right (a button that reveals a search field, so the box
 * never sits stacked above the chat), and the topic filter chips when present. It
 * is a thin strip with a hairline foot — not a panel — so the transcript stays the
 * hero.
 */
function ConversationHeader({
  kids,
  focusedChildId,
  setFocusedChildId,
  topicsInUse,
  topicFilter,
  setTopicFilter,
  search,
  setSearch,
}: {
  kids: TimelineChild[];
  focusedChildId: string | null;
  setFocusedChildId: (id: string | null) => void;
  topicsInUse: string[];
  topicFilter: string | null;
  setTopicFilter: (t: string | null) => void;
  search: string;
  setSearch: (q: string) => void;
}) {
  const searchId = useId();
  const [searchOpen, setSearchOpen] = useState(false);
  const showScope = kids.length > 0;
  const showTopics = topicsInUse.length > 0;

  function closeSearch() {
    setSearch('');
    setSearchOpen(false);
  }

  return (
    <div className="border-b border-rule pb-3">
      <div className="mx-auto w-full max-w-[64rem] space-y-3">
        <div className="flex items-center gap-3">
          {showScope ? (
            <div className="min-w-0 flex-1 overflow-x-auto">
              <ScopeChips
                kids={kids}
                focusedChildId={focusedChildId}
                setFocusedChildId={setFocusedChildId}
              />
            </div>
          ) : (
            <span className="meta flex-1">your one ongoing conversation</span>
          )}
          <button
            type="button"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            aria-expanded={searchOpen}
            aria-label={searchOpen ? 'close search' : 'search this conversation'}
            className="pill pill-action cursor-pointer shrink-0"
          >
            {searchOpen ? <X aria-hidden size={16} /> : <Search aria-hidden size={16} />}
          </button>
        </div>

        {searchOpen ? (
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faded-sage">
              <Search aria-hidden size={18} />
            </span>
            <label htmlFor={searchId} className="sr-only">
              search this conversation
            </label>
            <input
              id={searchId}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search this conversation"
              className="field field-search"
              autoComplete="off"
              // biome-ignore lint/a11y/noAutofocus: revealed on demand by the search toggle, so focus belongs here
              autoFocus
            />
          </div>
        ) : null}

        {showTopics ? (
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
    </div>
  );
}

/**
 * The first-screen welcome — centered in the transcript region before any turn
 * exists. A warm one-line invite, the per-child scope chips, the stage-aware
 * suggestion chips (which prefill + send), and the calm privacy note. Mirrors a
 * chat app's empty state rather than an editorial header.
 */
function EmptyState({
  canAsk,
  suggestions,
  focusedChildId,
  kids,
  setFocusedChildId,
  onPick,
  disabled,
}: {
  canAsk: boolean;
  suggestions: SuggestionGroup[];
  focusedChildId: string | null;
  kids: TimelineChild[];
  setFocusedChildId: (id: string | null) => void;
  onPick: (prompt: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-[34rem] flex-col items-center gap-6 py-12 text-center sm:py-16">
      <div className="space-y-3">
        <h1 className="font-display text-balance">
          ask Hale <span className="text-apricot-deep">anything</span>
        </h1>
        <p className="text-slate-green text-lg leading-relaxed">
          one ongoing conversation, grounded in your family. I answer in plain language and cite the
          source — never medical advice.
        </p>
      </div>
      {kids.length > 0 ? (
        <div className="flex justify-center">
          <ScopeChips
            kids={kids}
            focusedChildId={focusedChildId}
            setFocusedChildId={setFocusedChildId}
          />
        </div>
      ) : null}
      {canAsk ? (
        <Suggestions
          suggestions={suggestions}
          focusedChildId={focusedChildId}
          onPick={onPick}
          disabled={disabled}
          align="center"
        />
      ) : null}
    </div>
  );
}

/**
 * The grouped timeline of turns. Mobile-first: one column, bounded line-length, a
 * scope chip shown only when the turn's scope CHANGES from the prior turn (message
 * grouping). Assistant turns render markdown + any gated action chips.
 *
 * Two arrangements share this one component: `quote` (the Home hero's editorial
 * read — the parent's turn as a display quote) and `chat` (the /coach surface — a
 * real transcript: the parent's turn right, in an apricot bubble; Hale's answer
 * left, in an oat card with a small identity marker).
 */
function Timeline({
  turns,
  childLabelOf,
  focusedChildId,
  layout = 'quote',
}: {
  turns: Turn[];
  childLabelOf: (id: string | null) => string;
  focusedChildId: string | null;
  layout?: 'quote' | 'chat';
}) {
  const chat = layout === 'chat';
  let lastScope: string | null | undefined;
  return (
    <div className={chat ? 'space-y-6' : 'space-y-5'} aria-live="polite">
      {turns.map((turn) => {
        const scopeKey = `${turn.childId ?? 'family'}`;
        const showScope = scopeKey !== lastScope;
        lastScope = scopeKey;
        return (
          <div key={turn.id} className={`space-y-2 ${chat ? 'rise' : ''}`}>
            {showScope ? (
              <p className={`eyebrow text-faded-sage ${chat ? 'text-center' : ''}`}>
                {childLabelOf(turn.childId)}
              </p>
            ) : null}
            {turn.role === 'user' ? (
              chat ? (
                <div className="flex justify-end">
                  <p className="chat-bubble-you w-fit max-w-[85%] sm:max-w-prose">{turn.body}</p>
                </div>
              ) : (
                <p className="max-w-prose font-display text-[1.15rem] leading-snug text-spruce">
                  &ldquo;{turn.body}&rdquo;
                </p>
              )
            ) : (
              <article
                className={
                  chat
                    ? 'chat-bubble-hale w-fit max-w-[92%] sm:max-w-prose'
                    : 'panel max-w-prose'
                }
              >
                {chat ? <p className="eyebrow mb-2 text-sky-deep">Hale</p> : null}
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
          Sign in to ask Hale. In development preview (auth not configured) the ask box is read-only
          — no question is sent and no model is called.
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

function FullSurface({
  canAsk,
  chat,
  seed,
}: { canAsk: boolean; chat: UseAskHale; seed: ThreadSeed }) {
  const {
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
  } = chat;
  const childLabelOf = useChildLabel(seed.children);
  const isEmpty = turns.length === 0;

  // `.coach-surface` turns the stage into a non-scrolling flex column (globals.css
  // `:has`): this surface fills the remaining height, and the TRANSCRIPT scrolls
  // inside its own region while the composer stays pinned to the surface foot — a
  // real chat layout, not the whole page scrolling.
  return (
    <div className="coach-surface flex min-h-0 flex-1 flex-col">
      {/* Quiet header — the conversation's scope + a secondary search, never a box
          stacked above the chat. Hidden until there's history to scope or search. */}
      {!isEmpty ? (
        <ConversationHeader
          kids={seed.children}
          focusedChildId={focusedChildId}
          setFocusedChildId={setFocusedChildId}
          topicsInUse={topicsInUse}
          topicFilter={topicFilter}
          setTopicFilter={setTopicFilter}
          search={search}
          setSearch={setSearch}
        />
      ) : null}

      {/* The transcript — the hero. Its own scroll region; the composer sits below
          it, not over it, so nothing is hidden behind a floating bar. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[64rem] px-1 pb-6 pt-2">
          {isEmpty ? (
            <EmptyState
              canAsk={canAsk}
              suggestions={seed.suggestions}
              focusedChildId={focusedChildId}
              kids={seed.children}
              setFocusedChildId={setFocusedChildId}
              onPick={ask}
              disabled={status === 'pending'}
            />
          ) : visibleTurns.length === 0 ? (
            <output className="meta italic mt-6 block text-center">
              nothing here for this filter — clear it to see the rest of your conversation.
            </output>
          ) : (
            <Timeline
              turns={visibleTurns}
              childLabelOf={childLabelOf}
              focusedChildId={focusedChildId}
              layout="chat"
            />
          )}

          {status === 'pending' && streamingId === null ? (
            <div className="rise mt-6 flex" aria-live="polite">
              <p className="chat-bubble-hale typing-dots" aria-label="Hale is thinking">
                <span />
                <span />
                <span />
              </p>
            </div>
          ) : null}
          <div ref={threadEndRef} />
        </div>
      </div>

      {/* Pinned composer — solid canvas bar (flips with the theme via --color-linen)
          with a hairline top seam, anchored to the surface foot. The safe-area pad
          keeps the input clear of the mobile keyboard / home bar. */}
      <div className="sticky bottom-0 border-t border-rule bg-linen pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto w-full max-w-[64rem]">
          {canAsk ? (
            <div className="space-y-3">
              {!isEmpty ? (
                <Suggestions
                  suggestions={seed.suggestions}
                  focusedChildId={focusedChildId}
                  onPick={ask}
                  disabled={status === 'pending'}
                />
              ) : null}
              <Composer
                inputRef={inputRef}
                draft={draft}
                setDraft={setDraft}
                ask={ask}
                status={status}
              />
              {status === 'error' ? (
                <p className="meta italic text-apricot-deep" role="alert">
                  Couldn&rsquo;t reach Hale — try again in a moment.
                </p>
              ) : (
                <ComposerNote />
              )}
            </div>
          ) : (
            <output className="dev-preview-banner">
              Sign in to ask Hale. In development preview (auth not configured) the thread is
              read-only — no question is sent and no model is called.
            </output>
          )}
        </div>
      </div>
    </div>
  );
}

/** The composer field + send affordance — a rounded input row with the send button
 *  tucked at its trailing edge. ⌘/Ctrl+Enter sends; the label stays sr-only so the
 *  placeholder carries the prompt. */
function Composer({
  inputRef,
  draft,
  setDraft,
  ask,
  status,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (v: string) => void;
  ask: (q: string) => void;
  status: AskStatus;
}) {
  const pending = status === 'pending';
  return (
    <div className="composer-shell">
      <label htmlFor="coach-input" className="sr-only">
        ask Hale
      </label>
      <textarea
        ref={inputRef}
        id="coach-input"
        name="question"
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            ask(draft);
          }
        }}
        placeholder="ask about this child, or your whole family…"
        className="composer-input"
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => ask(draft)}
        disabled={pending || draft.trim().length === 0}
        aria-label={pending ? 'thinking' : 'ask Hale'}
        className={`composer-send cursor-pointer ${DISABLED_AFFORDANCE}`}
      >
        <ArrowUp aria-hidden size={20} />
      </button>
    </div>
  );
}
