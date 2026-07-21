'use client';

import { Search, Sparkles } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { VillageFeed } from '~/components/hale/village-feed';
import { Icon } from '~/components/ui/icon';
import { searchVillageAction, type VillageSearchResult } from '~/lib/village/ai-search-action';
import { resolveSearchView } from '~/lib/village/ai-search-view';

/**
 * The Village natural-language search — the founder's "ask a knowledgeable neighbour"
 * bar. A parent types a plain-English ask ("a good Montessori start in fall") and
 * Hale UNDERSTANDS it (an LLM intent parse) and searches REAL local listings — it
 * never fabricates a program. This component owns the whole search experience: the
 * input, the loading/results/honest-empty states, the interpretation echo ("what Hale
 * understood"), and a clear-back. The standing Village board is rendered as `children`
 * when no search is active, so the page mounts this in one place with the board inside.
 *
 * Self-contained by design (it lands alongside a concurrent Village-page edit): its
 * only coupling to the page is `areaKey` — when the family switches active region the
 * page re-renders with a new key and this resets, so a search never bleeds across
 * areas (the same reset-on-switch the board uses).
 */

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: VillageSearchResult; query: string };

export function VillageAiSearch({
  areaKey,
  area = null,
  children,
}: {
  /** The active area's identity — a change resets the search (reset-on-switch). */
  areaKey: string;
  /** Coarse area label for the result copy (never precise — rule #1). */
  area?: string | null;
  /** The standing Village board, shown when no search is active. */
  children: React.ReactNode;
}) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });

  // Reset on active-area change so a "fall in Toronto" search never lingers after the
  // parent switches to another region (mirrors the board's reset-on-switch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on areaKey only.
  useEffect(() => {
    setState({ status: 'idle' });
    setQuery('');
  }, [areaKey]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = query.trim();
    if (!prompt) return;
    setState({ status: 'loading' });
    const result = await searchVillageAction(prompt);
    setState({ status: 'done', result, query: prompt });
  }

  function clear() {
    setState({ status: 'idle' });
    setQuery('');
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="relative" aria-label="ask Hale to find something in your village">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faded-sage">
          <Icon as={Search} size={18} />
        </span>
        <label htmlFor={searchId} className="sr-only">
          Ask Hale to find activities, childcare, or resources near you
        </label>
        <input
          id={searchId}
          type="search"
          className="field field-search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Ask Hale — “a good Montessori start in fall”"
          autoComplete="off"
          enterKeyHint="search"
        />
      </form>

      {state.status === 'idle' ? children : null}
      {state.status === 'loading' ? <SearchLoading /> : null}
      {state.status === 'done' ? (
        <SearchResults result={state.result} area={area} onClear={clear} />
      ) : null}
    </div>
  );
}

/** The quiet "Hale is reading your ask" state while the intent parse + search runs. */
function SearchLoading() {
  return (
    <output className="rise rise-2 flex items-center gap-3 panel-oat px-6 py-5" aria-live="polite">
      <Icon as={Sparkles} size={18} className="shrink-0 text-apricot-deep animate-pulse" />
      <span className="meta text-slate-green">Hale is reading your ask and looking near you…</span>
    </output>
  );
}

/** The result surface: the honest interpretation echo + a clear-back, then the real
 * results or an honest empty/looking state — never a fabricated listing. The
 * state→surface decision is the tested resolveSearchView; this only renders it. */
function SearchResults({
  result,
  area,
  onClear,
}: {
  result: VillageSearchResult;
  area: string | null;
  onClear: () => void;
}) {
  const view = resolveSearchView(result);

  if (view.kind === 'notice') {
    return (
      <ResultShell interpretation={view.interpretation} onClear={onClear}>
        <EmptyPanel title={view.title} body={view.body} />
      </ResultShell>
    );
  }

  return (
    <ResultShell interpretation={view.interpretation} onClear={onClear}>
      {view.degraded ? (
        <p className="meta text-faded-sage mb-4">
          Hale couldn’t fully parse that, so it searched on your words.
        </p>
      ) : null}

      {view.kind === 'results' ? (
        <div className="space-y-6" aria-live="polite">
          <VillageFeed candidates={view.results} area={area} />
          {view.stillLooking ? (
            <p className="meta text-slate-green italic">
              Hale is out looking for more near you — check back soon.
            </p>
          ) : null}
        </div>
      ) : (
        <EmptyPanel
          title="nothing matching yet."
          body={
            view.stillLooking
              ? 'Hale is out looking for this near you — check back in a little while.'
              : 'Try another phrasing, or a different season or activity.'
          }
        />
      )}
    </ResultShell>
  );
}

/** The result frame: a banner naming what Hale understood + an instant clear back to
 * the standing village (a plain reset — no search cost). */
function ResultShell({
  interpretation,
  onClear,
  children,
}: {
  interpretation: string;
  onClear: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rise rise-2 space-y-6">
      <div className="panel-oat px-6 py-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="meta text-spruce">
          Hale understood: <span className="text-apricot-deep" data-hale-pii>{interpretation}</span>
        </span>
        <button type="button" onClick={onClear} className="link">
          back to your village
        </button>
      </div>
      {children}
    </div>
  );
}

/** A calm, honest empty/looking panel — never a blank surface (rule #8). */
function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <section className="panel-oat px-6 py-12 lg:py-16 text-center">
      <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">{title}</p>
      <p className="meta mt-4 text-slate-green max-w-xl mx-auto">{body}</p>
    </section>
  );
}
