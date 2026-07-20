'use client';

import { Calendar, ExternalLink, FolderOpen, Mail } from 'lucide-react';

/**
 * Onboarding step 8 — connect Google apps (design handoff §4.1 Ob8). These use the
 * REAL connector OAuth flow that ships on main: each "Connect" is a link to
 * /api/integrations/{provider}/connect, which starts Google consent and, on
 * return, stores the connection (the callback lands on /connected).
 *
 * Because that consent round-trip navigates away from the browser, the link opens
 * in a NEW TAB so the onboarding flow stays intact — the parent connects, then
 * returns here and continues. The button never flips to a fake "Connected": the
 * wizard can't verify the new-tab result without a round-trip, and claiming a
 * connection Hale hasn't confirmed would be dishonest. Real connection status
 * lives in Settings → Connected apps once linked. Nothing here acts on its own —
 * connections only feed drafts the parent approves.
 */

const APPS: readonly {
  provider: string;
  label: string;
  blurb: string;
  icon: typeof Calendar;
}[] = [
  {
    provider: 'gcal',
    label: 'Google Calendar',
    blurb: 'Keep your family schedule in sync',
    icon: Calendar,
  },
  { provider: 'gmail', label: 'Gmail', blurb: 'I can draft emails and reminders', icon: Mail },
  {
    provider: 'gdrive',
    label: 'Google Drive',
    blurb: 'Store and organize important docs',
    icon: FolderOpen,
  },
];

export function OnboardingConnect() {
  return (
    <ul className="flex flex-col gap-3">
      {APPS.map((app) => {
        const Icon = app.icon;
        return (
          <li
            key={app.provider}
            className="card flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--r-sm)]"
                style={{ background: 'var(--color-apricot-tint)' }}
                aria-hidden="true"
              >
                <Icon size={20} strokeWidth={2} style={{ color: 'var(--color-apricot-deep)' }} />
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-spruce">{app.label}</p>
                <p className="meta mt-0.5">{app.blurb}</p>
              </div>
            </div>
            <a
              href={`/api/integrations/${app.provider}/connect`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary shrink-0"
            >
              Connect
              <ExternalLink size={15} strokeWidth={2} aria-hidden="true" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
