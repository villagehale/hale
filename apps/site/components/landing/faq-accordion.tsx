'use client';

import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { AnimatedText } from '~/components/landing/animated-text';
import { FAQ } from '~/lib/faq';

/**
 * FAQ accordion. Items come from the single lib/faq source of truth (the same set
 * /faq renders and derives its FAQPage schema from), so a homepage answer can never
 * drift from the /faq answer. Every answer is verified against Hale's real privacy
 * policy and product rules — no overclaiming. Single-open: the first item is open by
 * default; the open answer expands via a 0fr → 1fr grid transition (static under
 * prefers-reduced-motion). Item 0's answer is rendered word-by-word via AnimatedText.
 */

export function FaqAccordion() {
  const [open, setOpen] = useState(0);

  return (
    <div>
      {FAQ.map((item, i) => {
        const isOpen = open === i;
        const panelId = `faq-panel-${i}`;
        const buttonId = `faq-button-${i}`;
        return (
          <div key={item.question} className="border-b border-dashed border-[#5C6B87]/40">
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
                  {item.question}
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
              inert={!isOpen ? true : undefined}
              className={`grid transition-[grid-template-rows,opacity] duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
                isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden">
                {i === 0 ? (
                  <AnimatedText
                    as="p"
                    text={item.answer}
                    baseDelayMs={120}
                    stepMs={18}
                    className="pb-8 pr-4 text-base leading-relaxed text-[#5C6B87] md:pr-12 md:text-lg"
                  />
                ) : (
                  <p className="pb-8 pr-4 text-base leading-relaxed text-[#5C6B87] md:pr-12 md:text-lg">
                    {item.answer}
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
