import { ArrowUp, Sparkles } from 'lucide-react';
import { Icon } from '~/components/ui/icon';

/**
 * The Home ask bar — a compact single-line entry into Ask Hale, not the hero.
 * A native GET form to /coach: typing and pressing enter (or the send arrow) opens
 * the full Ask Hale conversation, where the real thread, suggestions, and voice input
 * live. The typed question rides as `?q=` and /coach seeds it into the composer
 * (WEB-02), so it is never dropped. The submit glyph is a send arrow — voice lives in
 * the /coach composer, so a Mic here would misrepresent what the button does.
 */
export function AskBar() {
  return (
    <form
      action="/coach"
      method="get"
      className="flex items-center gap-3 rounded-[var(--r-lg)] border border-rule bg-oat px-4 py-3 shadow-[0_1px_2px_rgba(13,27,61,0.04)] transition-colors focus-within:border-apricot-deep"
    >
      <Icon as={Sparkles} size={18} className="shrink-0 text-apricot-deep" />
      <input
        name="q"
        type="text"
        placeholder="Ask Hale anything…"
        aria-label="Ask Hale anything"
        className="min-w-0 flex-1 border-0 bg-transparent text-spruce placeholder:text-faded-sage focus:outline-none"
      />
      <button
        type="submit"
        aria-label="Ask Hale"
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-slate-green transition-colors hover:bg-linen hover:text-spruce"
      >
        <Icon as={ArrowUp} size={18} />
      </button>
    </form>
  );
}
