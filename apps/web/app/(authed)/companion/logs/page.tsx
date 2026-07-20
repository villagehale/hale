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

      {/* Title + back-to-Companion breadcrumb live in the shell top bar (§3.2). */}
      <section className="rise rise-2">
        <LogsBrowser initial={initial} kids={kids} units={units} />
      </section>
    </div>
  );
}
