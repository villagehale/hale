'use client';

import { Copy, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { Button } from '~/components/ui/button';

type State =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; link: string; copied: boolean }
  | { kind: 'unavailable' }
  | { kind: 'error' };

/**
 * Mints a co-parent invite via POST /api/invite and surfaces the returned link
 * with a copy button. Rule #5 (only members invite, role co_parent) is enforced
 * server-side — the route's resolved family IS the membership proof; this is just
 * the UI. Honest about failure: 501 (auth not configured) / 403 (no family yet)
 * read as "unavailable", and a clipboard-blocked browser still shows the link to
 * copy by hand.
 */
export function InviteCoParent() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const capture = useAnalytics();

  async function generate() {
    setState({ kind: 'generating' });
    try {
      const res = await fetch('/api/invite', { method: 'POST' });
      if (res.status === 201) {
        const { link } = (await res.json()) as { link: string };
        capture('first_invite');
        setState({ kind: 'ready', link, copied: false });
        return;
      }
      setState(res.status === 501 || res.status === 403 ? { kind: 'unavailable' } : { kind: 'error' });
    } catch {
      setState({ kind: 'error' });
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setState({ kind: 'ready', link, copied: true });
    } catch {
      setState({ kind: 'ready', link, copied: false });
    }
  }

  if (state.kind === 'ready') {
    return (
      <div className="space-y-4">
        <p className="meta text-slate-green">
          share this one-time link with your co-parent. it expires in 14 days.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <p className="font-display text-lg break-all" data-hale-pii>
            {state.link}
          </p>
          <Button variant="secondary" icon={Copy} onClick={() => copy(state.link)} aria-live="polite">
            {state.copied ? 'copied' : 'copy link'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-spruce leading-relaxed max-w-md">
        Invite your co-parent so you can share the load. Until they join, anything that touches
        their data waits for your tap.
      </p>
      {state.kind === 'unavailable' ? (
        <output className="meta text-slate-green block">
          your invite link will be ready once your family is set up.
        </output>
      ) : null}
      {state.kind === 'error' ? (
        <p className="meta text-apricot-deep" role="alert">
          couldn&rsquo;t generate a link just now — please try again.
        </p>
      ) : null}
      <Button
        icon={UserPlus}
        onClick={generate}
        disabled={state.kind === 'generating'}
        aria-live="polite"
      >
        {state.kind === 'generating' ? 'generating…' : 'invite your co-parent'}
      </Button>
    </div>
  );
}
