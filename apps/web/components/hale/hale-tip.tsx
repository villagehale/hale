'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Mascot } from '~/components/hale/mascot';
import { Icon } from '~/components/ui/icon';

const TIP_KEY = 'hale.home.tip.dismissed.v1';

/**
 * The dismissible "Hale tip" card on Home (design handoff §4.2). The copy is
 * intentionally GENERIC editorial guidance, not a personalised insight — Hale has no
 * per-family tips engine, so a "tip just for you" would fabricate one (honesty lane).
 * Its one action points at the REAL Ask pipeline, where a parent can get an actual,
 * grounded answer. Dismissal persists in localStorage so it stays gone.
 */
export function HaleTip() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(TIP_KEY) === '1');
    } catch {
      // storage disabled → the tip simply shows every load; never a crash.
    }
  }, []);

  if (dismissed) return null;

  return (
    <div className="hale-tip">
      <button
        type="button"
        className="hale-tip-dismiss"
        aria-label="Dismiss tip"
        onClick={() => {
          try {
            localStorage.setItem(TIP_KEY, '1');
          } catch {
            // ignore — dismissal is best-effort persistence
          }
          setDismissed(true);
        }}
      >
        <Icon as={X} size={15} />
      </button>
      <Mascot pose="wave" size={44} className="hale-tip-mascot" />
      <p className="eyebrow hale-tip-eyebrow">Hale tip</p>
      <p className="hale-tip-body">
        Small, consistent routines help little ones settle. Ask Hale about your family&rsquo;s
        rhythm.
      </p>
      <Link href="/coach" className="hale-tip-link">
        Ask Hale &rarr;
      </Link>
    </div>
  );
}
