import { CalendarCheck, Moon, Sparkles, Stethoscope, Utensils } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import {
  BOOKING_EPISODE,
  FEED_EPISODE,
  MILESTONE_EPISODE,
  NAP_EPISODE,
} from '~/lib/companion/log-types';
import type { RecentLogView } from '~/lib/companion/recent-logs';

const ICON: Record<string, LucideIcon> = {
  [FEED_EPISODE]: Utensils,
  [NAP_EPISODE]: Moon,
  [MILESTONE_EPISODE]: Sparkles,
  [BOOKING_EPISODE]: Stethoscope,
};

function whenPhrase(occurredAt: string): string {
  return new Date(occurredAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The companion "recent logs" list. Reads from family_memory_episodes via
 * loadRecentLogs and renders the family's latest quick-logs. Fail-closed empty
 * state when nothing's been logged — never a fabricated row.
 */
export function RecentLogs({ logs }: { logs: RecentLogView[] }) {
  if (logs.length === 0) {
    return (
      <p className="text-lg text-spruce leading-relaxed">
        nothing logged yet — use quick log below to note a feed, a nap, or a milestone, and it will
        gather here.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {logs.map((log) => (
        <li
          key={log.id}
          className="flex items-baseline gap-4 border-t border-rule pt-4 first:border-t-0 first:pt-0"
        >
          <span className="shrink-0 text-apricot-deep">
            <Icon as={ICON[log.episodeType] ?? CalendarCheck} size={18} />
          </span>
          <span className="text-lg text-spruce leading-relaxed flex-1">{log.summary}</span>
          <span className="eyebrow text-faded-sage shrink-0">{whenPhrase(log.occurredAt)}</span>
        </li>
      ))}
    </ul>
  );
}
