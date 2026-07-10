import Link from 'next/link';
import { scopeChildren } from '~/components/hale/child-scope-core';
import { LogsBrowser } from '~/components/hale/logs-browser';
import { PageCorner } from '~/components/hale/page-corner';
import { loadCompanion } from '~/lib/companion/queries';
import { loadLogsPage } from '~/lib/companion/logs-page';
import { loadViewerProfile } from '~/lib/family';

/**
 * The dedicated, scalable logs surface — the full history of the family's
 * quick-logs, day-grouped and load-more paginated, filterable per child. Distinct
 * from the 8-row companion widget (a quick glance); this is where logs live as
 * they accumulate. The per-child filter shows each child by NAME (policy 1) via
 * scopeChildren; a teen's LOG CONTENT is redacted upstream by loadLogsPage.
 */
export default async function CompanionLogsPage() {
  const [initial, children, profile] = await Promise.all([
    loadLogsPage(),
    loadCompanion(),
    loadViewerProfile(),
  ]);

  const kids = scopeChildren(children);
  const units = profile?.units ?? 'metric';

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
            <LogsBrowser initial={initial} kids={kids} units={units} />
          </div>
        </div>
      </section>
    </div>
  );
}
