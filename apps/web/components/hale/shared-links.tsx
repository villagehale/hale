'use client';

import { useEffect, useState } from 'react';

/**
 * The "links you have shared" list with a per-link Revoke (rules #1, #6). Fetches
 * the family-scoped list from /api/village/shares on mount; each row reveals an
 * inline confirm, then POSTs the revoke to /api/village/shares/revoke. On success
 * the token is nulled server-side (the public page then fails closed) and the row
 * leaves the list. Honest states: a load error and a per-row revoke error surface
 * calmly — never a silent failure.
 */

type ShareLinkKind = 'week_plan' | 'activity';

interface SharedLink {
  kind: ShareLinkKind;
  id: string;
  token: string;
  title: string;
}

const KIND_LABEL: Record<ShareLinkKind, string> = {
  week_plan: 'this week with Hale',
  activity: 'a local pick',
};

type LoadState = 'loading' | 'loaded' | 'error';

export function SharedLinks() {
  const [links, setLinks] = useState<SharedLink[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/village/shares');
        if (!res.ok) {
          if (active) setLoad('error');
          return;
        }
        const body = (await res.json()) as { links: SharedLink[] };
        if (active) {
          setLinks(body.links);
          setLoad('loaded');
        }
      } catch {
        if (active) setLoad('error');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function onRevoked(id: string) {
    setLinks((prev) => prev.filter((l) => l.id !== id));
  }

  if (load === 'loading') {
    return <p className="meta text-slate-green">loading your shared links…</p>;
  }
  if (load === 'error') {
    return <p className="meta text-berry">could not load your shared links — try again.</p>;
  }
  if (links.length === 0) {
    return (
      <p className="text-spruce leading-relaxed max-w-md">
        You haven&rsquo;t shared any public links. When you share a week plan or a local pick,
        it&rsquo;ll appear here so you can turn it off any time.
      </p>
    );
  }

  return (
    <ul className="flex flex-col">
      {links.map((link) => (
        <SharedLinkRow key={`${link.kind}-${link.id}`} link={link} onRevoked={onRevoked} />
      ))}
    </ul>
  );
}

type RowState = 'view' | 'confirm' | 'revoking' | 'error';

function SharedLinkRow({
  link,
  onRevoked,
}: {
  link: SharedLink;
  onRevoked: (id: string) => void;
}) {
  const [state, setState] = useState<RowState>('view');

  async function revoke() {
    setState('revoking');
    try {
      const res = await fetch('/api/village/shares/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: link.kind, id: link.id }),
      });
      if (res.status !== 200) {
        setState('error');
        return;
      }
      onRevoked(link.id);
    } catch {
      setState('error');
    }
  }

  return (
    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-rule py-3 first:border-t-0 first:pt-0">
      <span className="eyebrow text-faded-sage shrink-0">{KIND_LABEL[link.kind]}</span>
      <span className="text-spruce leading-relaxed flex-1" data-hale-pii>
        {link.title}
      </span>

      {state === 'confirm' || state === 'revoking' ? (
        <span className="flex items-center gap-2 shrink-0" aria-live="polite">
          <span className="meta text-slate-green">turn off?</span>
          <button
            type="button"
            className="link cursor-pointer"
            onClick={revoke}
            disabled={state === 'revoking'}
          >
            {state === 'revoking' ? 'turning off…' : 'yes'}
          </button>
          <button
            type="button"
            className="meta cursor-pointer text-slate-green"
            onClick={() => setState('view')}
            disabled={state === 'revoking'}
          >
            no
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="link text-berry cursor-pointer shrink-0"
          onClick={() => setState('confirm')}
          aria-label={`revoke shared link: ${link.title}`}
        >
          revoke
        </button>
      )}

      {state === 'error' ? (
        <span className="basis-full meta text-berry" role="alert">
          could not turn off this link — try again.
        </span>
      ) : null}
    </li>
  );
}
