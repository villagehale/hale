import nextDynamic from 'next/dynamic';
import { AuditMixClient } from '~/components/admin/bar-list-client';
import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { cachedAuditMix } from '~/lib/admin/cached';
import { SKILLS_REPO_URL, supabaseTableUrl } from '~/lib/admin/links';
import { skillsInventory } from '~/lib/admin/skills-inventory';

const DataTable = nextDynamic(() =>
  import('~/components/admin/data-table').then((m) => m.DataTable),
);
const BarsChart = nextDynamic(() =>
  import('~/components/admin/bars-chart').then((m) => m.BarsChart),
);

/** Ledger — "What has Hale actually done, on the record?" */

async function ActionsPerDayBody() {
  const rows = await cachedAuditMix();
  if (rows.length === 0) return <p className="adm-state">No audit rows in this window.</p>;
  // Zero new SQL: the day×action rows summed to day totals; the dial slices client-side.
  const byDay = new Map<string, number>();
  for (const row of rows) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.count);
  }
  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, value]) => ({ day, value }));
  return <BarsChart rows={days} name="actions" height={140} />;
}

async function AuditMixBody() {
  const rows = await cachedAuditMix();
  if (rows.length === 0) return <p className="adm-state">No audit rows in this window.</p>;
  return <AuditMixClient rows={rows} />;
}

function SkillsBody() {
  const rows = skillsInventory();
  return (
    <details className="adm-details">
      <summary>Capabilities on file ({rows.length} skills)</summary>
      <DataTable
        rows={rows.map((skill) => ({ name: skill.name, sha: skill.shaShort }))}
        columns={[
          { key: 'name', label: 'skill' },
          { key: 'sha', label: 'sha256', mono: true },
        ]}
        filterPlaceholder="filter skills…"
      />
    </details>
  );
}

export default function AdminLedgerPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Actions per day',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('audit_log') }],
      body: <ActionsPerDayBody />,
      span2: true,
    },
    {
      eyebrow: 'What Hale did',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('audit_log') }],
      body: <AuditMixBody />,
      span2: true,
    },
    {
      eyebrow: 'Skills inventory',
      links: [{ label: 'Open in GitHub', href: SKILLS_REPO_URL }],
      body: <SkillsBody />,
      span2: true,
    },
  ];
  return (
    <main className="adm-stage">
      <PanelGrid panels={panels} />
    </main>
  );
}
