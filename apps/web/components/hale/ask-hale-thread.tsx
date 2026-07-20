'use client';

import { ArrowRight, ArrowUp, Paperclip, Search, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ActionChip } from '~/components/hale/action-chip';
import { AskSessionRail } from '~/components/hale/ask-session-rail';
import type { ConnectorChip } from '~/components/hale/coach-context-panel';
import { ConnectorCard } from '~/components/hale/connector-card';
import { HaleContextRail } from '~/components/hale/hale-context-rail';
import { InputIntentWidgets } from '~/components/hale/input-intent-widget';
import { Markdown } from '~/components/hale/markdown';
import {
  type Activity,
  type AskStatus,
  type Turn,
  type UseAskHale,
  useAskHale,
} from '~/components/hale/use-ask-hale';
import { VoiceMicButton } from '~/components/hale/voice-mic-button';
import { Button } from '~/components/ui/button';
import {
  ATTACHMENTS_ENABLED,
  type AttachmentChipTone,
  attachmentChipTone,
  formatAttachmentSize,
} from '~/lib/coach/attachment-ui';
import { greetingLine } from '~/lib/coach/greeting';
import type { ConversationSummary } from '~/lib/coach/history';
import type { SuggestionGroup, ThreadSeed, TimelineChild } from '~/lib/coach/thread';

export type AskHaleVariant = 'compact' | 'full';

interface AskHaleThreadProps {
  /** Whether the signed-in parent may spend (auth configured). */
  canAsk: boolean;
  /** Server-rehydrated shell — the one conversation's timeline + chips + suggestions. */
  seed: ThreadSeed;
  /** 'compact' = Home hero entry; 'full' = the /coach continuous timeline. */
  variant: AskHaleVariant;
  /** The family's connectors, for the /coach Context section. Empty on the Home hero. */
  connectors?: ConnectorChip[];
  /** RSC-rehydrated first page of the family's Ask sessions, for the full surface's
   * session rail. Empty on the Home hero. */
  initialConversations?: ConversationSummary[];
  /** Pre-scope the conversation to a child (contextual entry), or null for the family. */
  initialFocusedChildId?: string | null;
  /** Signed-in parent's first name, for the full surface's empty-state greeting. */
  viewerName?: string | null;
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
  connectors = [],
  initialConversations = [],
  initialFocusedChildId = null,
  viewerName = null,
}: AskHaleThreadProps) {
  const chat = useAskHale(seed, initialFocusedChildId);
  return variant === 'compact' ? (
    <CompactSurface canAsk={canAsk} chat={chat} seed={seed} />
  ) : (
    <FullSurface
      canAsk={canAsk}
      chat={chat}
      seed={seed}
      connectors={connectors}
      initialConversations={initialConversations}
      viewerName={viewerName}
    />
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
          <span data-hale-pii>{child.label ?? 'your teen'}</span>
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
/**
 * Erase the whole conversation (rule #6, soft-delete). A destructive action, so it
 * is confirm-gated: the trash pill reveals an inline confirm before it calls the
 * audited /api/coach/delete. On success the timeline clears; a failure surfaces a
 * calm note rather than a silent no-op.
 */
function EraseConversationControl({ onErase }: { onErase: () => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'erasing' | 'error'>('idle');

  async function erase() {
    setState('erasing');
    const ok = await onErase();
    setState(ok ? 'idle' : 'error');
  }

  if (state === 'confirm' || state === 'erasing') {
    return (
      <span className="flex items-center gap-2 shrink-0" aria-live="polite">
        <span className="meta text-slate-green">erase this conversation?</span>
        <button
          type="button"
          className="link cursor-pointer"
          onClick={erase}
          disabled={state === 'erasing'}
        >
          {state === 'erasing' ? 'erasing…' : 'yes'}
        </button>
        <button
          type="button"
          className="meta cursor-pointer text-slate-green"
          onClick={() => setState('idle')}
          disabled={state === 'erasing'}
        >
          no
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={() => setState('confirm')}
        aria-label="erase this conversation"
        className="pill pill-action cursor-pointer hover:text-berry"
      >
        <Trash2 aria-hidden size={16} />
      </button>
      {state === 'error' ? (
        <span className="meta text-berry" role="alert">
          couldn&rsquo;t erase — try again.
        </span>
      ) : null}
    </span>
  );
}

function ConversationHeader({
  kids,
  focusedChildId,
  setFocusedChildId,
  topicsInUse,
  topicFilter,
  setTopicFilter,
  search,
  setSearch,
  onErase,
}: {
  kids: TimelineChild[];
  focusedChildId: string | null;
  setFocusedChildId: (id: string | null) => void;
  topicsInUse: string[];
  topicFilter: string | null;
  setTopicFilter: (t: string | null) => void;
  search: string;
  setSearch: (q: string) => void;
  /** Erase the whole conversation (soft-delete every turn, rule #6). */
  onErase: () => Promise<boolean>;
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
          <EraseConversationControl onErase={onErase} />
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
 * The stage-aware suggestion TILES for the empty state — a 2-column grid of bordered
 * cards (a navy spark + the question) that prefill + send (desktop handoff §4.4). The
 * prompts are REAL stage-aware suggestions; there is no fabricated category sub-line
 * (the suggestions carry none). On the first screen the prompts are the primary call
 * to action, so they read as tappable tiles rather than a cluster of small chips.
 */
function SuggestionTiles({
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
    <div className="grid gap-3 sm:grid-cols-2">
      {group.prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPick(prompt)}
          disabled={disabled}
          className={`ask-suggestion-tile cursor-pointer ${DISABLED_AFFORDANCE}`}
        >
          <Sparkles aria-hidden size={18} className="shrink-0 text-spruce" />
          <span className="min-w-0 flex-1 text-left">{prompt}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The first-screen welcome — the landing before any turn exists (desktop handoff
 * §4.4): a serif "Good evening, {name}." with the "What can I do for your family
 * today?" sub-line, the per-child scope chips, and the stage-aware suggestion tiles
 * (which prefill + send). The greeting word is time-of-day, so it is computed on the
 * client (suppressHydrationWarning) — the server render may differ by a word.
 */
function EmptyState({
  canAsk,
  suggestions,
  focusedChildId,
  kids,
  setFocusedChildId,
  onPick,
  disabled,
  viewerName,
}: {
  canAsk: boolean;
  suggestions: SuggestionGroup[];
  focusedChildId: string | null;
  kids: TimelineChild[];
  setFocusedChildId: (id: string | null) => void;
  onPick: (prompt: string) => void;
  disabled: boolean;
  viewerName: string | null;
}) {
  const firstName = viewerName?.trim().split(/\s+/)[0] ?? null;
  return (
    <div className="mx-auto flex max-w-[40rem] flex-col gap-6 py-6 sm:py-10">
      <div className="space-y-2">
        <p
          suppressHydrationWarning
          className="font-display text-[1.6rem] lg:text-[1.9rem] font-semibold leading-tight"
        >
          <span data-hale-pii>{greetingLine(firstName, new Date())}</span>
        </p>
        <p className="text-slate-green leading-relaxed">What can I do for your family today?</p>
      </div>
      {kids.length > 0 ? (
        <ScopeChips
          kids={kids}
          focusedChildId={focusedChildId}
          setFocusedChildId={setFocusedChildId}
        />
      ) : null}
      {canAsk ? (
        <SuggestionTiles
          suggestions={suggestions}
          focusedChildId={focusedChildId}
          onPick={onPick}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

/**
 * The live step/tool activity trail for an assistant turn — the work Hale did to
 * answer, between the question and the answer. Rule #1: it renders ONLY what the
 * server streamed (a tool name + content-free preview), never args or raw output;
 * the client has no authority to reconstruct tool data it was never sent.
 *
 * Minimal + collapsible: while streaming (`live`) it shows a quiet "Exploring…"
 * header with each settled tool line; once the answer lands it collapses into a
 * <details> disclosure ("Explored N steps") so a finished turn stays uncluttered.
 * A blocked tool (ok:false) is called out in the attention tone (rule #7/#1 refusals
 * are observable, never silent).
 */
function ActivityTrail({ activity, live }: { activity: Activity[]; live: boolean }) {
  const results = activity.filter(
    (a): a is Extract<Activity, { kind: 'tool_result' }> => a.kind === 'tool_result',
  );
  const pendingCall = activity.at(-1)?.kind === 'tool_call';
  if (results.length === 0 && !live) return null;

  const lines = (
    <ul className="space-y-1">
      {results.map((r, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: activity is append-only, so index is a stable identity
          key={i}
          className={`meta flex items-center gap-2 ${r.ok ? 'text-slate-green' : 'text-berry'}`}
        >
          <span aria-hidden>{r.ok ? '✓' : '✕'}</span>
          <span>{r.preview}</span>
        </li>
      ))}
      {live && pendingCall ? (
        <li className="meta flex items-center gap-2 text-faded-sage">
          <span aria-hidden>…</span>
          <span>Exploring</span>
        </li>
      ) : null}
    </ul>
  );

  if (live) {
    return (
      <div className="mb-3 border-l-2 border-rule pl-3">
        <p className="eyebrow mb-1 text-faded-sage">Exploring</p>
        {lines}
      </div>
    );
  }

  return (
    <details className="mb-3 border-l-2 border-rule pl-3">
      <summary className="eyebrow cursor-pointer text-faded-sage">
        Explored {results.length} {results.length === 1 ? 'step' : 'steps'}
      </summary>
      <div className="mt-1">{lines}</div>
    </details>
  );
}

/**
 * The small navy spark that marks a Hale reply (mockup panel 2). It carries the
 * turn's author as a visually-hidden name so a screen reader announces "Hale" even
 * though the visible identity is the glyph.
 */
function HaleSpark() {
  return (
    <span className="mt-0.5 shrink-0 text-spruce">
      <Sparkles size={18} aria-hidden />
      <span className="sr-only">Hale</span>
    </span>
  );
}

/**
 * The grouped timeline of turns. Mobile-first: one column, bounded line-length, a
 * scope chip shown only when the turn's scope CHANGES from the prior turn (message
 * grouping). Assistant turns render markdown + any gated action chips.
 *
 * Two arrangements share this one component: `quote` (the Home hero's editorial
 * read — the parent's turn as a display quote) and `chat` (the /coach surface — a
 * real transcript: the parent's turn right, in a navy (spruce) bubble; Hale's
 * answer left, beside a small spark identity marker).
 */
function Timeline({
  turns,
  childLabelOf,
  kids,
  layout = 'quote',
  streamingId,
  deletableIds,
  onDeleteTurn,
}: {
  turns: Turn[];
  childLabelOf: (id: string | null) => string;
  kids: TimelineChild[];
  layout?: 'quote' | 'chat';
  /** The id of the turn currently streaming, so its activity trail renders "live". */
  streamingId?: string | null;
  /** Ids of persisted turns a parent may remove (rule #6). Absent = no delete. */
  deletableIds?: ReadonlySet<string>;
  onDeleteTurn?: (id: string) => Promise<boolean>;
}) {
  const chat = layout === 'chat';
  let lastScope: string | null | undefined;
  return (
    <div className={chat ? 'space-y-6' : 'space-y-5'}>
      {turns.map((turn) => {
        const scopeKey = `${turn.childId ?? 'family'}`;
        const showScope = scopeKey !== lastScope;
        lastScope = scopeKey;
        const canDelete = Boolean(onDeleteTurn && deletableIds?.has(turn.id));
        return (
          <div key={turn.id} className={`group space-y-2 ${chat ? 'rise' : ''}`}>
            {showScope ? (
              <p className={`eyebrow text-faded-sage ${chat ? 'text-center' : ''}`}>
                <span data-hale-pii>{childLabelOf(turn.childId)}</span>
              </p>
            ) : null}
            {turn.role === 'user' ? (
              <>
                {chat ? (
                  <div className="flex justify-end">
                    <p className="chat-bubble-you w-fit max-w-[85%] sm:max-w-prose" data-hale-pii>
                      {turn.body}
                    </p>
                  </div>
                ) : (
                  <p
                    className="max-w-prose font-display text-[1.15rem] leading-snug text-spruce"
                    data-hale-pii
                  >
                    &ldquo;{turn.body}&rdquo;
                  </p>
                )}
                {turn.inputIntents && turn.inputIntents.length > 0 ? (
                  <InputIntentWidgets
                    intents={turn.inputIntents}
                    focusedChildId={turn.childId}
                    question={turn.body}
                    kids={kids}
                  />
                ) : null}
              </>
            ) : chat ? (
              // The /coach transcript reads Hale's answer as plain text beside a small
              // navy spark marker (mockup panel 2) — not a bubble card. The spark
              // carries a visually-hidden "Hale" so the turn's author is still named.
              <article className="flex gap-3">
                <HaleSpark />
                <div className="min-w-0 flex-1 space-y-2">
                  {turn.activity && turn.activity.length > 0 ? (
                    <ActivityTrail activity={turn.activity} live={turn.id === streamingId} />
                  ) : null}
                  {turn.activity
                    ?.filter(
                      (a): a is Extract<Activity, { kind: 'tool_result' }> =>
                        a.kind === 'tool_result' && a.card !== undefined,
                    )
                    .map((a, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: cards are an ordered, append-only slice of one turn's activity
                      <ConnectorCard key={i} card={a.card as NonNullable<typeof a.card>} />
                    ))}
                  <div data-hale-pii className="max-w-prose leading-relaxed">
                    <Markdown>{turn.body}</Markdown>
                  </div>
                  {turn.actionIntents && turn.actionIntents.length > 0 ? (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {turn.actionIntents.map((intent) => (
                        <ActionChip
                          key={intent.kind}
                          intent={intent}
                          focusedChildId={turn.childId}
                          sourceAnswer={turn.body}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            ) : (
              <article className="panel max-w-prose">
                {turn.activity && turn.activity.length > 0 ? (
                  <ActivityTrail activity={turn.activity} live={turn.id === streamingId} />
                ) : null}
                {turn.activity
                  ?.filter(
                    (a): a is Extract<Activity, { kind: 'tool_result' }> =>
                      a.kind === 'tool_result' && a.card !== undefined,
                  )
                  .map((a, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cards are an ordered, append-only slice of one turn's activity
                    <ConnectorCard key={i} card={a.card as NonNullable<typeof a.card>} />
                  ))}
                <div data-hale-pii>
                  <Markdown>{turn.body}</Markdown>
                </div>
                {turn.actionIntents && turn.actionIntents.length > 0 ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {turn.actionIntents.map((intent) => (
                      <ActionChip
                        key={intent.kind}
                        intent={intent}
                        focusedChildId={turn.childId}
                        sourceAnswer={turn.body}
                      />
                    ))}
                  </div>
                ) : null}
              </article>
            )}
            {canDelete && onDeleteTurn ? (
              <TurnDeleteControl
                align={turn.role === 'user' ? 'end' : 'start'}
                onDelete={() => onDeleteTurn(turn.id)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Per-turn removal (rule #6, soft-delete): a quiet trash affordance that reveals an
 * inline confirm, then calls the audited /api/coach/delete. Hidden until the turn is
 * hovered/focused (group-hover) so it never clutters the read; on failure it surfaces
 * a calm inline note rather than silently doing nothing.
 */
function TurnDeleteControl({
  align,
  onDelete,
}: {
  align: 'start' | 'end';
  onDelete: () => Promise<boolean>;
}) {
  const [state, setState] = useState<'idle' | 'confirm' | 'deleting' | 'error'>('idle');

  async function remove() {
    setState('deleting');
    const ok = await onDelete();
    // Success drops the turn from the timeline (the row unmounts); only a failure
    // remains here to be shown.
    if (!ok) setState('error');
  }

  const justify = align === 'end' ? 'justify-end' : 'justify-start';

  if (state === 'confirm' || state === 'deleting') {
    return (
      <div className={`flex items-center gap-2 ${justify}`} aria-live="polite">
        <span className="meta text-slate-green">remove this message?</span>
        <button
          type="button"
          className="link cursor-pointer"
          onClick={remove}
          disabled={state === 'deleting'}
        >
          {state === 'deleting' ? 'removing…' : 'yes'}
        </button>
        <button
          type="button"
          className="meta cursor-pointer text-slate-green"
          onClick={() => setState('idle')}
          disabled={state === 'deleting'}
        >
          no
        </button>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${justify}`}>
      <button
        type="button"
        onClick={() => setState('confirm')}
        aria-label="remove this message"
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-faded-sage opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:text-berry cursor-pointer"
      >
        <Trash2 aria-hidden size={14} />
      </button>
      {state === 'error' ? (
        <span className="meta text-berry" role="alert">
          couldn&rsquo;t remove — try again.
        </span>
      ) : null}
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

/**
 * The one discrete live region for the conversation. A polite live region must be a
 * SMALL status node, not the whole growing transcript — otherwise every streamed
 * token re-announces the entire visible thread. This announces only the state
 * transitions: "Hale is thinking" when a request is in flight, then "Hale replied"
 * once it resolves (only after a pending phase, so idle-on-mount stays silent). The
 * answer text itself is read by the user navigating the transcript, not shouted.
 */
function AssistantLiveStatus({ status }: { status: AskStatus }) {
  const [message, setMessage] = useState('');
  const wasPending = useRef(false);
  useEffect(() => {
    if (status === 'pending') {
      setMessage('Hale is thinking');
      wasPending.current = true;
    } else if (wasPending.current) {
      setMessage(status === 'error' ? 'Hale could not reply' : 'Hale replied');
      wasPending.current = false;
    }
  }, [status]);
  return (
    <output className="sr-only" aria-live="polite">
      {message}
    </output>
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
          Sign in to ask Hale. In this preview the ask box is read-only — no question is sent.
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
        <div className="flex items-center gap-2">
          <VoiceMicButton onTranscript={setDraft} />
          <Button
            icon={ArrowRight}
            onClick={() => ask(draft)}
            disabled={status === 'pending' || draft.trim().length === 0}
          >
            {status === 'pending' ? 'thinking…' : 'ask'}
          </Button>
        </div>
      </div>

      {status === 'error' ? (
        <p className="meta italic text-apricot-deep" role="alert">
          Couldn&rsquo;t reach Hale — try again in a moment.
        </p>
      ) : null}

      {visibleTurns.length > 0 ? (
        <div className="rise rise-1">
          <Timeline turns={visibleTurns} childLabelOf={childLabelOf} kids={seed.children} />
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
  connectors,
  initialConversations,
  viewerName,
}: {
  canAsk: boolean;
  chat: UseAskHale;
  seed: ThreadSeed;
  connectors: ConnectorChip[];
  initialConversations: ConversationSummary[];
  viewerName: string | null;
}) {
  const {
    turns,
    visibleTurns,
    status,
    streamingId,
    draft,
    setDraft,
    ask,
    activeConversationId,
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
  } = chat;
  const childLabelOf = useChildLabel(seed.children);
  const isEmpty = turns.length === 0;
  // The only REAL "pending draft" signal: an assistant turn proposed an action Hale is
  // holding for approval (rule #4). No live Gmail-draft loader exists, so absent this
  // the collapsed context rail shows no dot rather than a fabricated one.
  const hasPendingDraft = visibleTurns.some(
    (t) => t.role === 'assistant' && (t.actionIntents?.length ?? 0) > 0,
  );
  // Only PERSISTED turns (present in the server-rehydrated seed) carry a real
  // message id the audited delete can resolve; an in-session turn's client id would
  // 404. So the delete affordance is offered on the seeded set only.
  const deletableIds = useMemo(() => new Set(seed.timeline.map((m) => m.id)), [seed.timeline]);

  // `.coach-surface` turns the stage into a non-scrolling flex column (globals.css
  // `:has`): this row fills the remaining height. On lg+ it is a two-column app view —
  // the chat column (its transcript scrolls inside its own region, composer pinned to
  // the foot) beside a bordered context rail. Below lg the rail drops away and the
  // chat is single-column, full-width.
  return (
    <div className="coach-surface flex min-h-0 flex-1 gap-6">
      <AskSessionRail
        initialConversations={initialConversations}
        activeId={activeConversationId}
        refreshSignal={historyRevision}
        onNewChat={newChat}
        onOpen={openConversation}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* No own heading here: the app shell's PageHero (§3.2) renders the sole "Hale"
            hero for the /coach root, in the desktop top bar and the narrow-viewport
            stage alike. A second heading would stack two serif titles once a
            conversation exists and duplicate the page title in the a11y tree. */}
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
            onErase={eraseConversation}
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
                viewerName={viewerName}
              />
            ) : visibleTurns.length === 0 ? (
              <output className="meta italic mt-6 block text-center">
                nothing here for this filter — clear it to see the rest of your conversation.
              </output>
            ) : (
              <Timeline
                turns={visibleTurns}
                childLabelOf={childLabelOf}
                kids={seed.children}
                layout="chat"
                streamingId={streamingId}
                deletableIds={deletableIds}
                onDeleteTurn={deleteTurn}
              />
            )}

            {status === 'pending' && streamingId === null ? (
              <div className="rise mt-6 flex items-center gap-3" aria-hidden>
                <Sparkles size={18} className="shrink-0 text-spruce" />
                <span className="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : null}
            <AssistantLiveStatus status={status} />
            <div ref={threadEndRef} />
          </div>
        </div>

        {/* Pinned composer — solid canvas bar (flips with the theme via --color-linen)
            with a hairline top seam, anchored to the surface foot. The safe-area pad
            keeps the input clear of the mobile keyboard / home bar. */}
        <div className="sticky bottom-0 border-t border-rule bg-linen pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto w-full max-w-[64rem]">
            {canAsk ? (
              // The footer stays short so the transcript keeps the viewport on a
              // narrow phone: the stage-aware suggestion rows live in the empty
              // state's transcript (not stacked here), and the medical disclaimer
              // shows only on the first screen — once the parent is chatting, an
              // error is the only thing worth the extra row.
              <div className="space-y-3">
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
                ) : isEmpty ? (
                  <p className="meta text-center">
                    Hale is AI-powered and not a substitute for professional medical advice.
                  </p>
                ) : null}
              </div>
            ) : (
              <output className="dev-preview-banner">
                Sign in to ask Hale. In this preview the thread is read-only — no question is sent.
              </output>
            )}
          </div>
        </div>
      </div>

      <HaleContextRail connectors={connectors} hasPendingDraft={hasPendingDraft} />
    </div>
  );
}

/** One staged composer attachment — the metadata the upload route returned, plus the
 *  rotating chip tone. The bytes already live server-side; only the id rides the send. */
interface ComposerAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  tone: AttachmentChipTone;
}

/** The upload route's response row (feat/b4-chat-attachments). */
interface UploadedAttachment {
  id: string;
  name: string;
  sizeBytes: number;
}

/**
 * The composer field + send affordance — a rounded input row with the paperclip at
 * the leading edge and the mic + navy send tucked at the trailing edge (desktop
 * handoff §4.4). Enter sends; Shift+Enter (and ⌘/Ctrl+Enter) inserts a newline. The
 * label stays sr-only so the placeholder carries the prompt.
 *
 * Attachments are gated behind ATTACHMENTS_ENABLED so this ships before the B4 backend
 * (feat/b4-chat-attachments) lands: with it off, the paperclip never renders and no
 * upload is attempted. On: the paperclip opens a multi-file picker, uploads to
 * /api/coach/attachments, and shows removable name+size chips (4-tone cycle) above the
 * input; the returned ids ride the send. A send may carry attachments only.
 */
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
  ask: (q: string, attachmentIds?: string[]) => void;
  status: AskStatus;
}) {
  const pending = status === 'pending';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const canSend = !pending && !uploading && (draft.trim().length > 0 || attachments.length > 0);

  function submit() {
    if (!canSend) return;
    ask(
      draft,
      attachments.map((a) => a.id),
    );
    setAttachments([]);
  }

  async function uploadChosen(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append('files', file);
      const res = await fetch('/api/coach/attachments', { method: 'POST', body: form });
      if (!res.ok) {
        setUploadError('Couldn’t attach that — try again.');
        return;
      }
      const uploaded = (await res.json()) as UploadedAttachment[];
      setAttachments((prev) => [
        ...prev,
        ...uploaded.map((u, i) => ({
          id: u.id,
          name: u.name,
          sizeBytes: u.sizeBytes,
          tone: attachmentChipTone(prev.length + i),
        })),
      ]);
    } catch {
      setUploadError('Couldn’t attach that — try again.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-2">
      {ATTACHMENTS_ENABLED && attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <li key={a.id} className={`attach-chip attach-chip-${a.tone}`}>
              <Paperclip aria-hidden size={12} className="shrink-0" />
              <span data-hale-pii className="max-w-[12rem] truncate">
                {a.name}
              </span>
              <span className="opacity-70">{formatAttachmentSize(a.sizeBytes)}</span>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                aria-label={`Remove ${a.name}`}
                className="ml-0.5 inline-flex cursor-pointer items-center"
              >
                <X aria-hidden size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {ATTACHMENTS_ENABLED && uploadError ? (
        <p className="meta italic text-berry" role="alert">
          {uploadError}
        </p>
      ) : null}

      <div className="composer-shell">
        {ATTACHMENTS_ENABLED ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => uploadChosen(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="attach files"
              className={`composer-mic cursor-pointer ${DISABLED_AFFORDANCE}`}
            >
              <Paperclip aria-hidden size={18} />
            </button>
          </>
        ) : null}
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
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask Hale anything…"
          className="composer-input"
          autoComplete="off"
        />
        <VoiceMicButton onTranscript={setDraft} />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label={pending ? 'thinking' : 'ask Hale'}
          className={`composer-send cursor-pointer ${DISABLED_AFFORDANCE}`}
        >
          <ArrowUp aria-hidden size={20} />
        </button>
      </div>
    </div>
  );
}
