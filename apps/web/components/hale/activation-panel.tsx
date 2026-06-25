'use client';

import { ArrowRight, Check, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '~/components/ui/icon';
import type { ActivationStep } from '~/lib/activation/checklist';

/**
 * First-run activation — a calm "start here" beside the village hero, never a loud
 * onboarding banner. Each step's done-state comes from real family data (derived
 * server-side); a done step reads in the sage done-tone with a check, an open step
 * is a tappable link to its action. The panel auto-hides once every step is done
 * (the parent has the loop) — that vanishing is the primary mechanism. A manual
 * dismiss persists in localStorage so it never nags, mirroring UpgradePrompt.
 */
export const ACTIVATION_DISMISSED_KEY = 'hale.activation-dismissed';

export function ActivationPanel({ steps }: { steps: ActivationStep[] }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(ACTIVATION_DISMISSED_KEY) === '1') {
      setDismissed(true);
    }
  }, []);

  if (dismissed) return null;

  function dismiss() {
    localStorage.setItem(ACTIVATION_DISMISSED_KEY, '1');
    setDismissed(true);
  }

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section className="panel-oat px-6 py-6 lg:px-8 lg:py-7" aria-label="Getting started">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="eyebrow">start here</span>
          <p className="font-display text-[1.25rem] lg:text-[1.5rem] text-spruce mt-1 leading-snug">
            four small steps to find your footing.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss getting started"
          className="upgrade-prompt-dismiss -mr-2"
        >
          <Icon as={X} size={18} className="text-faded-sage" />
        </button>
      </div>

      <ol className="mt-5 space-y-px">
        {steps.map((step, idx) => (
          <li
            key={step.id}
            className="flex items-center gap-3 border-t border-rule py-3 first:border-t-0"
          >
            {step.done ? (
              <>
                <span className="pill pill-sage shrink-0">
                  <Icon as={Check} size={14} className="text-sage" />
                  done
                </span>
                <span className="text-slate-green line-through decoration-rule">{step.label}</span>
              </>
            ) : (
              <>
                <span className="tabular text-faded-sage w-5 shrink-0 text-sm">{idx + 1}</span>
                <Link href={step.href} className="link inline-flex items-center gap-1.5">
                  {step.label}
                  <Icon as={ArrowRight} size={14} />
                </Link>
              </>
            )}
          </li>
        ))}
      </ol>

      <p className="meta mt-4 text-faded-sage">
        {doneCount} of {steps.length} done — this clears itself once you&rsquo;ve found your way
        around.
      </p>
    </section>
  );
}
