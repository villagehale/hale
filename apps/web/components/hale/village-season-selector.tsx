'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { searchActivitiesForSeasonAction } from '~/lib/village/search-action';
import { searchResultToUi } from '~/lib/village/season-selector-ui';
import { SEASONS, type Season } from '~/lib/village/visibility';

/** A surfaced non-success from a search — the text, plus an optional inline link
 * (e.g. to /family where the area is set). */
type Message = { text: string; link?: { href: string; label: string } };

/**
 * The season picker at the top of the feed. A chip per season triggers a fresh,
 * paid discovery scoped to it (the discovery runs synchronously — seconds — so
 * the chosen chip shows a pending state); on a real discovery the page navigates
 * to `?season=<season>` so the RSC renders that search run. A "your feed" chip
 * clears back to the standing feed instantly (no discovery cost). Every
 * non-success surfaces an honest message in place (rule #8), never a swallowed
 * null. The season swap is non-urgent, so it runs in a transition.
 */
export function VillageSeasonSelector({ active = null }: { active?: Season | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [searching, setSearching] = useState<Season | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  function search(season: Season) {
    setMessage(null);
    setSearching(season);
    startTransition(async () => {
      try {
        const ui = searchResultToUi(await searchActivitiesForSeasonAction(season), season);
        if (ui.kind === 'navigate') {
          router.push(`/village?season=${ui.season}`);
        } else {
          setMessage({ text: ui.text, link: ui.link });
        }
      } catch {
        setMessage({ text: 'could not run that search — please try again.' });
      } finally {
        setSearching(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <fieldset
        className="flex flex-wrap gap-1 rounded-[var(--r-full)] border border-rule-strong p-1"
        aria-label="search a future season, or return to your weekly feed"
      >
        <Link
          href="/village"
          aria-current={active === null ? 'true' : undefined}
          className={`pill pill-action ${active === null ? 'bg-spruce text-on-spruce' : 'bg-transparent text-slate-green'}`}
          style={{ touchAction: 'manipulation' }}
        >
          your feed
        </Link>
        {SEASONS.map((season) => {
          const isActive = active === season;
          const isPending = pending && searching === season;
          return (
            <button
              key={season}
              type="button"
              aria-pressed={isActive}
              onClick={() => search(season)}
              disabled={pending}
              className={`pill pill-action ${isActive ? 'bg-spruce text-on-spruce' : 'bg-transparent text-slate-green'}`}
              style={{ touchAction: 'manipulation' }}
            >
              {isPending ? `searching ${season}…` : season}
            </button>
          );
        })}
      </fieldset>
      {message !== null ? (
        <output className="meta text-slate-green block" aria-live="polite">
          {message.text}
          {message.link !== undefined ? (
            <>
              {' '}
              <Link href={message.link.href} className="link">
                {message.link.label}
              </Link>
            </>
          ) : null}
        </output>
      ) : null}
    </div>
  );
}
