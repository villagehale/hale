'use client';

import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import type { FaqItem } from '~/lib/faq';

/**
 * The canonical product FAQ accordion on /faq. Items are handed in by the route so
 * the same lib/faq source derives both these panels and the FAQPage schema — and so
 * the landing-flag branch that chooses between the two lists stays on the server.
 * Every answer is verified against Hale's real privacy policy and product rules — no
 * overclaiming. Single-open: the first item is open by default; the open answer
 * expands via a 0fr → 1fr grid transition (static under prefers-reduced-motion).
 */

export function ProductFaqAccordion({ items }: { items: readonly FaqItem[] }) {
  const [open, setOpen] = useState(0);

  return (
    <div>
      {items.map((item, i) => {
        const isOpen = open === i;
        const panelId = `faq-panel-${i}`;
        const buttonId = `faq-button-${i}`;
        return (
          <div key={item.question} className="border-b border-dashed border-slate-green/40">
            <h3>
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? -1 : i)}
                className="group flex w-full items-center justify-between gap-6 py-6 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spruce md:py-8"
              >
                <span className="text-xl font-medium tracking-tight text-spruce transition-opacity group-hover:opacity-70 md:text-[1.7rem]">
                  {item.question}
                </span>
                <span aria-hidden className="shrink-0 text-spruce">
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
              inert={!isOpen ? true : undefined}
              className={`grid transition-[grid-template-rows,opacity] duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
                isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden">
                <p className="pb-8 pr-4 text-base leading-relaxed text-slate-green md:pr-12 md:text-lg">
                  {item.answer}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
