import { MessageCircleHeart } from 'lucide-react';
import { AskBox } from '~/components/hale/ask-box';
import { Icon } from '~/components/ui/icon';
import type { ThreadSeed } from '~/lib/coach/thread';

/**
 * Ask Hale as the village CONCIERGE — present, not the hero. The agent-ranked
 * village feed leads the home/primary surface; this is the calm entry below it
 * where a parent asks Hale to refine what their village shows them (or ask
 * anything). It reuses the one shared Ask Hale conversation (AskBox →
 * AskHaleThread compact) so the thread is the same continuous, memory-backed
 * conversation as /coach — only the framing differs: a quiet panel that names its
 * job ("ask Hale to refine your feed") rather than a full-bleed headline.
 */
export function ConciergeAsk({ canAsk, seed }: { canAsk: boolean; seed: ThreadSeed }) {
  return (
    <div className="panel-oat px-6 py-6 lg:px-8 lg:py-8 space-y-4">
      <div className="flex items-center gap-3">
        <Icon as={MessageCircleHeart} size={20} className="text-apricot-deep" />
        <div>
          <h2 className="eyebrow text-spruce">your concierge</h2>
          <p className="meta mt-1 text-slate-green">
            ask your concierge to refine your feed — or anything about your family
          </p>
        </div>
      </div>
      <AskBox canAsk={canAsk} seed={seed} />
    </div>
  );
}
