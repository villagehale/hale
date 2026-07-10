import type { Route } from 'next';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';

/**
 * One nav tile on the Family hub: an icon, a title + subtitle, a trailing
 * chevron, and — only when `badge` is a positive count — an orange count pill
 * (the AI-orange accent reserved for "needs your eye"). The whole tile is a
 * single link (the Card interactive variant), so it never lies about being
 * clickable.
 */
export function FamilyHubCard({
  icon,
  title,
  subtitle,
  href,
  badge,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  href: Route;
  badge?: number;
}) {
  return (
    <Card href={href} className="flex items-start gap-4">
      <Icon as={icon} size={22} className="mt-0.5 shrink-0 text-slate-green" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-display font-semibold text-spruce">{title}</span>
          {badge && badge > 0 ? (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-apricot px-1.5 py-0.5 text-xs font-semibold leading-none text-on-spruce tabular">
              {badge}
            </span>
          ) : null}
        </div>
        <p className="meta mt-1">{subtitle}</p>
      </div>
      <Icon as={ChevronRight} size={18} className="mt-0.5 shrink-0 text-faded-sage" />
    </Card>
  );
}
