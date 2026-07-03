import Link from 'next/link';
import type { ScopeChild } from '~/components/hale/child-scope';
import { LogsBrowser } from '~/components/hale/logs-browser';
import { PageCorner } from '~/components/hale/page-corner';
import { loadCompanion } from '~/lib/companion/queries';
import { loadLogsPage } from '~/lib/companion/logs-page';

/**
 * The dedicated, scalable logs surface — the full history of the family's
 * quick-logs, day-grouped and load-more paginated, filterable per child. Distinct
 * from the 8-row companion widget (a quick glance); this is where logs live as
 * they accumulate. A teen's given name is withheld from the filter (rule #1):
 * stage 'teenager' → label null → "your teen".
 */
export default async function CompanionLogsPage() {
  const [initial, children] = await Promise.all([loadLogsPage(), loadCompanion()]);

  const kids: ScopeChild[] = children.map((child) => ({
    id: child.id,
    label: child.stage === 'teenager' ? null : child.name,
  }));

  return (
    <div>
      <PageCorner section="companion · logs" />

      <header className="rise rise-1 mb-12 lg:mb-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your logs</span>
            <p className="meta mt-2 text-slate-green">feeds · naps · milestones</p>
          </div>
          <div className="lg:col-span-9 space-y-4">
            <h1 className="font-display">
              every note, <span className="text-apricot-deep">gathered</span>.
            </h1>
            <Link href="/companion" className="link">
              ← back to your companion
            </Link>
          </div>
        </div>
      </header>

      <section className="rise rise-3">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
          <div className="lg:col-span-3" />
          <div className="lg:col-span-9">
            <LogsBrowser initial={initial} kids={kids} />
          </div>
        </div>
      </section>
    </div>
  );
}
