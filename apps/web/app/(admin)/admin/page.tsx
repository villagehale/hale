import nextDynamic from 'next/dynamic';
import { Suspense } from 'react';
import { AuditMixClient } from '~/components/admin/bar-list-client';
import { IntakeFunnelClient } from '~/components/admin/intake-funnel-client';
import { Panel, PanelSkeleton } from '~/components/admin/panel';
import { PanelBoundary } from '~/components/admin/panel-boundary';
import { PulseBand } from '~/components/admin/pulse-band';
import { Reveal } from '~/components/admin/reveal';
import { SpendClient } from '~/components/admin/spend-client';
import { WindowDialProvider } from '~/components/admin/window-dial';
import {
  cachedAgentSpend,
  cachedAuditMix,
  cachedDbErrors,
  cachedGrowth,
  cachedIntakeFunnel,
  cachedLangfuseDaily,
  cachedPulse,
  cachedRadar,
  cachedReplays,
  cachedSiteFunnel,
  cachedTextingTrends,
  cachedTwilioAlerts,
} from '~/lib/admin/cached';
import {
  ANTHROPIC_USAGE_URL,
  langfuseHomeUrl,
  posthogInsightsUrl,
  posthogReplayHomeUrl,
  posthogReplayUrl,
  SKILLS_REPO_URL,
  supabaseTableUrl,
  TWILIO_ERROR_LOGS_URL,
} from '~/lib/admin/links';
import { EMPTY_WINDOW_LINE, serviceStateLine } from '~/lib/admin/panel-state';
import { SITE_FUNNEL_DAYS } from '~/lib/admin/services/posthog';
import { skillsInventory } from '~/lib/admin/skills-inventory';

// Chart/table islands are code-split off the server payload — this route only.
const TrendChart = nextDynamic(() =>
  import('~/components/admin/trend-chart').then((m) => m.TrendChart),
);
const BarsChart = nextDynamic(() =>
  import('~/components/admin/bars-chart').then((m) => m.BarsChart),
);
const FunnelBars = nextDynamic(() =>
  import('~/components/admin/funnel-bars').then((m) => m.FunnelBars),
);
const DataTable = nextDynamic(() =>
  import('~/components/admin/data-table').then((m) => m.DataTable),
);

const STALE_VERIFY_DAYS = 7;

async function BandBody() {
  const pulse = await cachedPulse();
  return <PulseBand pulse={pulse} />;
}

async function TextingBody() {
  const rows = await cachedTextingTrends();
  if (rows.length === 0) return <p className="adm-state">{EMPTY_WINDOW_LINE}</p>;
  return <TrendChart rows={rows} />;
}

async function GrowthBody() {
  const growth = await cachedGrowth();
  return (
    <div>
      <div className="adm-stat-row">
        <div className="adm-stat">
          <div className="adm-stat-v">{growth.total}</div>
          <div className="adm-stat-k">families</div>
        </div>
        <div className="adm-stat">
          <div className="adm-stat-v">{growth.foundingCount}</div>
          <div className="adm-stat-k">founding</div>
        </div>
        {growth.tiers.map((tier) => (
          <div key={tier.tier} className="adm-stat">
            <div className="adm-stat-v">{tier.count}</div>
            <div className="adm-stat-k">{tier.tier}</div>
          </div>
        ))}
      </div>
      <BarsChart
        rows={growth.days.map((d) => ({ day: d.day, value: d.families }))}
        name="new families"
        height={150}
      />
    </div>
  );
}

async function IntakeFunnelBody() {
  const funnel = await cachedIntakeFunnel();
  if (funnel.days.length === 0) return <p className="adm-state">{EMPTY_WINDOW_LINE}</p>;
  return <IntakeFunnelClient days={funnel.days} sources={funnel.sources} />;
}

async function SiteFunnelBody() {
  const outcome = await cachedSiteFunnel();
  if (!outcome.ok) return <p className="adm-state">{serviceStateLine('PostHog', outcome)}</p>;
  return (
    <div>
      <FunnelBars stages={outcome.data} />
      <p className="adm-state">unique visitors · last {SITE_FUNNEL_DAYS}d</p>
    </div>
  );
}

async function ErrorsBody() {
  const [dbErrors, twilio] = await Promise.all([cachedDbErrors(), cachedTwilioAlerts()]);
  const rows = [...dbErrors, ...(twilio.ok ? twilio.data : [])].sort((a, b) =>
    a.at < b.at ? 1 : -1,
  );
  return (
    <div>
      {!twilio.ok ? <p className="adm-state">{serviceStateLine('Twilio', twilio)}</p> : null}
      {rows.length === 0 ? (
        <p className="adm-state">No failures in the last 30 days.</p>
      ) : (
        <DataTable
          rows={rows.map((row) => ({ ...row }))}
          columns={[
            { key: 'at', label: 'time', time: true },
            { key: 'source', label: 'source', dot: true },
            { key: 'code', label: 'code', mono: true },
            { key: 'summary', label: 'summary' },
          ]}
          initialSort={{ key: 'at', desc: true }}
          filterPlaceholder="filter errors…"
        />
      )}
    </div>
  );
}

async function ReplaysBody() {
  const outcome = await cachedReplays();
  if (!outcome.ok) return <p className="adm-state">{serviceStateLine('PostHog', outcome)}</p>;
  if (outcome.data.length === 0) return <p className="adm-state">No replays yet.</p>;
  return (
    <DataTable
      rows={outcome.data.map((replay) => ({
        startedAt: replay.startedAt,
        seconds: replay.durationSeconds,
        page: replay.startUrl.replace(/^https?:\/\//, ''),
        clicks: replay.clickCount,
        href: posthogReplayUrl(replay.id),
      }))}
      columns={[
        { key: 'startedAt', label: 'started', time: true },
        { key: 'seconds', label: 'secs' },
        { key: 'page', label: 'first page', mono: true },
        { key: 'clicks', label: 'clicks' },
        { key: 'href', label: 'replay', link: true },
      ]}
      initialSort={{ key: 'startedAt', desc: true }}
      filterPlaceholder="filter replays…"
    />
  );
}

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

async function RadarBody() {
  const radar = await cachedRadar();
  const freshest = radar.freshestVerifiedAt ? new Date(radar.freshestVerifiedAt) : null;
  const staleDays = freshest
    ? Math.floor((Date.now() - freshest.getTime()) / 86_400_000)
    : null;
  const openFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    month: 'short',
    day: 'numeric',
  });
  return (
    <div>
      {radar.upcoming.length === 0 ? (
        <p className="adm-state">No upcoming registration windows on file.</p>
      ) : (
        <div className="adm-radar-list">
          {radar.upcoming.map((w) => (
            <div key={`${w.municipality}-${w.programDomain}-${w.cycleLabel}`} className="adm-radar-row">
              <span>
                {w.municipality} · {w.programDomain.replace(/_/g, ' ')} · {w.cycleLabel}
              </span>
              <span className="adm-num">
                {openFormat.format(new Date(w.openAt))}
                {w.residentOpenAt ? ` (res ${openFormat.format(new Date(w.residentOpenAt))})` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="adm-state">
        {staleDays === null ? (
          'never verified'
        ) : staleDays > STALE_VERIFY_DAYS ? (
          <span className="adm-stale">verified {staleDays}d ago — stale</span>
        ) : (
          `verified ${staleDays}d ago`
        )}
        {radar.lastVerifyRun
          ? ` · last sweep: ${radar.lastVerifyRun.checked} checked, ${radar.lastVerifyRun.confirmed} confirmed, ${radar.lastVerifyRun.discrepancies} moved`
          : ''}
        {radar.outcomes.length > 0
          ? ` · outcomes: ${radar.outcomes.map((o) => `${o.outcome} ${o.count}`).join(' · ')}`
          : ''}
      </p>
    </div>
  );
}

async function AuditMixBody() {
  const rows = await cachedAuditMix();
  if (rows.length === 0) return <p className="adm-state">{EMPTY_WINDOW_LINE}</p>;
  return <AuditMixClient rows={rows} />;
}

function SkillsBody() {
  const rows = skillsInventory();
  return (
    <DataTable
      rows={rows.map((skill) => ({ name: skill.name, sha: skill.shaShort }))}
      columns={[
        { key: 'name', label: 'skill' },
        { key: 'sha', label: 'sha256', mono: true },
      ]}
      filterPlaceholder="filter skills…"
    />
  );
}

interface PanelSpec {
  eyebrow: string;
  links: { label: string; href: string }[];
  body: React.ReactNode;
  span2?: boolean;
}

export default function AdminPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Texting',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('channel_messages') }],
      body: <TextingBody />,
    },
    {
      eyebrow: 'Growth',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('families') }],
      body: <GrowthBody />,
    },
    {
      eyebrow: 'Text intake funnel',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('sms_intake_sessions') }],
      body: <IntakeFunnelBody />,
    },
    {
      eyebrow: 'Site funnel',
      links: [{ label: 'Open in PostHog', href: posthogInsightsUrl() }],
      body: <SiteFunnelBody />,
    },
    {
      eyebrow: 'Errors — Twilio + sends + agent runs',
      links: [{ label: 'Open in Twilio', href: TWILIO_ERROR_LOGS_URL }],
      body: <ErrorsBody />,
      span2: true,
    },
    {
      eyebrow: 'Session replays',
      links: [{ label: 'Open in PostHog', href: posthogReplayHomeUrl() }],
      body: <ReplaysBody />,
    },
    {
      eyebrow: 'Agent spend + activity',
      links: [
        { label: 'Langfuse', href: langfuseHomeUrl() },
        { label: 'Anthropic usage', href: ANTHROPIC_USAGE_URL },
      ],
      body: <SpendBody />,
    },
    {
      eyebrow: 'Radar',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('registration_windows') }],
      body: <RadarBody />,
    },
    {
      eyebrow: 'What Hale did',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('audit_log') }],
      body: <AuditMixBody />,
    },
    {
      eyebrow: 'Skills inventory',
      links: [{ label: 'Open in GitHub', href: SKILLS_REPO_URL }],
      body: <SkillsBody />,
      span2: true,
    },
  ];

  return (
    <main>
      <PanelBoundary label="The line">
        <Suspense fallback={<div className="adm-band" style={{ minHeight: 180 }} />}>
          <BandBody />
        </Suspense>
      </PanelBoundary>
      <WindowDialProvider>
        <div className="adm-grid">
          {panels.map((panel, index) => (
            <Reveal
              key={panel.eyebrow}
              index={index}
              className={panel.span2 ? 'adm-span2' : undefined}
            >
              <Panel eyebrow={panel.eyebrow} links={panel.links}>
                <PanelBoundary label={panel.eyebrow}>
                  <Suspense fallback={<PanelSkeleton />}>{panel.body}</Suspense>
                </PanelBoundary>
              </Panel>
            </Reveal>
          ))}
        </div>
      </WindowDialProvider>
    </main>
  );
}
