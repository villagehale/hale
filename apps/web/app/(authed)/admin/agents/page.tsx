import nextDynamic from 'next/dynamic';
import { SpendClient } from '~/components/admin/spend-client';
import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { cachedAgentSpend, cachedLangfuseDaily } from '~/lib/admin/cached';
import { ANTHROPIC_USAGE_URL, langfuseHomeUrl } from '~/lib/admin/links';
import { serviceStateLine } from '~/lib/admin/panel-state';

const AgentLeaderboard = nextDynamic(() =>
  import('~/components/admin/agent-leaderboard').then((m) => m.AgentLeaderboard),
);

/** Agents — "What does the fleet cost, and how is it performing?" */

async function SpendBody() {
  const [spend, langfuse] = await Promise.all([cachedAgentSpend(), cachedLangfuseDaily()]);
  const langfuseTraces = langfuse.ok
    ? langfuse.data.reduce((sum, day) => sum + day.traces, 0)
    : null;
  return (
    <div>
      <SpendClient data={spend} />
      {langfuse.ok ? (
        <p className="adm-state">
          Langfuse cross-check: <span className="adm-num">{langfuseTraces}</span> traces · last 30d
        </p>
      ) : (
        <p className="adm-state">{serviceStateLine('Langfuse', langfuse)}</p>
      )}
    </div>
  );
}

async function LeaderboardBody() {
  const spend = await cachedAgentSpend();
  return <AgentLeaderboard rows={spend.byAgentDay} />;
}

export default function AdminAgentsPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Agent spend + activity',
      links: [
        { label: 'Langfuse', href: langfuseHomeUrl() },
        { label: 'Anthropic usage', href: ANTHROPIC_USAGE_URL },
      ],
      body: <SpendBody />,
      span2: true,
    },
    {
      eyebrow: 'Agent leaderboard',
      links: [{ label: 'Langfuse', href: langfuseHomeUrl() }],
      body: <LeaderboardBody />,
      span2: true,
    },
  ];
  return (
    <main className="adm-stage">
      <PanelGrid panels={panels} />
    </main>
  );
}
