'use client';

import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { AnimatedText } from '~/components/landing/animated-text';

/**
 * Two-column FAQ accordion. Every answer is verified against Hale's real
 * privacy policy and product rules — no overclaiming. Single-open: the first
 * item is open by default; the open answer expands via a 0fr → 1fr grid
 * transition (static under prefers-reduced-motion).
 */

type FaqItem = {
  q: string;
  /** Plain-text answer; item 0 is rendered word-by-word via AnimatedText. */
  a: string;
};

const ITEMS: readonly FaqItem[] = [
  {
    q: 'Is my family’s data safe with Hale?',
    a: 'Privacy is the centre of Hale, not the fine print. Your family’s core data is stored in Canada, in Toronto, and everything is built for PIPEDA, Quebec’s Law 25, and CASL. We never sell your data, and we never use your children’s data for advertising.',
  },
  {
    q: 'Will Hale ever act without me?',
    a: 'No. Hale quietly prepares things — drafts, reminders, plans — but nothing reaches the outside world until you approve it. New accounts even start in an observe-only mode, so Hale learns your family before it suggests anything at all.',
  },
  {
    q: 'What ages does Hale support?',
    a: 'Every stage of childhood, from newborn through the teen years. Hale reads each child’s age and tailors what it surfaces — from nap logs and first foods to activities, forms, and the growing independence of a teenager.',
  },
  {
    q: 'What does Hale cost?',
    a: 'Hale is free to use right now. Paid plans will come later — with clear notice before anything changes.',
  },
  {
    q: 'Can both parents use it?',
    a: 'Yes. You can invite a co-parent into one shared family so you’re both in the loop. Anything that touches both parents’ data waits until you’re both on board — and single-parent households work fully on their own.',
  },
] as const;

export function FaqAccordion() {
  const [open, setOpen] = useState(0);

  return (
    <div>
      {ITEMS.map((item, i) => {
        const isOpen = open === i;
        const panelId = `faq-panel-${i}`;
        const buttonId = `faq-button-${i}`;
        return (
          <div key={item.q} className="border-b border-dashed border-[#5C6B87]/40">
            <h3>
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? -1 : i)}
                className="group flex w-full items-center justify-between gap-6 py-6 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17294A] md:py-8"
              >
                <span className="text-xl font-medium tracking-tight text-[#17294A] transition-opacity group-hover:opacity-70 md:text-[1.7rem]">
                  {item.q}
                </span>
                <span aria-hidden className="shrink-0 text-[#17294A]">
                  {isOpen ? (
                    <Minus className="w-6 md:w-7" strokeWidth={1.5} />
                  ) : (
                    <Plus className="w-6 md:w-7" strokeWidth={1.5} />
                  )}
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              className={`grid transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
                isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden">
                {i === 0 ? (
                  <AnimatedText
                    as="p"
                    text={item.a}
                    baseDelayMs={120}
                    stepMs={18}
                    className="pb-8 pr-4 text-base leading-relaxed text-[#5C6B87] md:pr-12 md:text-lg"
                  />
                ) : (
                  <p className="pb-8 pr-4 text-base leading-relaxed text-[#5C6B87] md:pr-12 md:text-lg">
                    {item.a}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
