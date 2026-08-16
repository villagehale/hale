import { Minus, Plus } from 'lucide-react';
import type { FaqItem } from '~/lib/faq';

/**
 * The canonical product FAQ on /faq. Items are handed in by the route so the same
 * lib/faq source derives both these panels and the FAQPage schema. Every answer is
 * verified against Hale's real privacy policy and product rules — no overclaiming.
 *
 * A native <details>, and that is the whole change from the React accordion it
 * replaces. The old one held its open item in useState, which meant that with its
 * JavaScript unarrived — slow connection, blocked bundle, a crawler that does not
 * execute — six of the seven answers could not be opened at all. `<details>` gives
 * the disclosure semantics, keyboard operation, focus, find-in-page and print
 * expansion for free, from markup that works before hydration because there is
 * nothing to hydrate. The shared `name` makes the group exclusive (one open at a
 * time) in the browser rather than in a state variable.
 *
 * The marker is ours: a plus that becomes a minus, swapped by CSS off the [open]
 * attribute — for the same reason, so it is never briefly wrong.
 */

export function ProductFaqAccordion({ items }: { items: readonly FaqItem[] }) {
  return (
    <div className="flex flex-col">
      {items.map((item, i) => (
        <details
          key={item.question}
          name="product-faq"
          open={i === 0}
          className="glass-panel disclosure"
        >
          <summary>
            {item.question}
            <span className="disclosure-mark" aria-hidden="true">
              <Plus className="disclosure-mark-closed w-6 md:w-7" strokeWidth={1.5} />
              <Minus className="disclosure-mark-open w-6 md:w-7" strokeWidth={1.5} />
            </span>
          </summary>
          <p className="disclosure-body">{item.answer}</p>
        </details>
      ))}
    </div>
  );
}
