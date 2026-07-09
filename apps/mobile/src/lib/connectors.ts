import type { IconName } from '@/components/ui/icon';
import type { TagTone } from '@/components/ui/tag';
import type { ConnectorProvider, IntegrationStatus } from './api-types';

/**
 * Framework-free connector metadata + status presentation, shared by the Settings
 * "Connected accounts" section and the onboarding connect step. No native imports
 * (bar the SF-Symbol NAME + Tag tone types), so it's unit-tested under src/lib.
 *
 * A connector is connection PLUMBING only — the benefit copy describes what Hale
 * can help WITH, never what it reads from the mailbox/calendar (rule #1). The raw→UI
 * status mapping lives server-side (the route normalizes); this side only renders
 * the status the server already vouched for.
 */

export type { ConnectorProvider };

export interface ConnectorMeta {
  provider: ConnectorProvider;
  name: string;
  /** One line about what connecting UNLOCKS — never about mailbox/calendar content. */
  benefit: string;
  icon: IconName;
}

export const CONNECTORS: readonly ConnectorMeta[] = [
  {
    provider: 'gcal',
    name: 'Google Calendar',
    benefit: 'So Hale can see what your week already holds.',
    icon: 'calendar',
  },
  {
    provider: 'gmail',
    name: 'Gmail',
    benefit: 'So Hale can catch the details that arrive by email.',
    icon: 'envelope.fill',
  },
  {
    provider: 'gdrive',
    name: 'Google Drive',
    benefit: 'So Hale can reach the documents you point it to.',
    icon: 'doc.text.fill',
  },
];

/** The status chip shown on a connector row: an honest label + a Tag tone. The
 * 'error' state reads as "Needs reconnecting" (never a silent green). */
export function statusChip(status: IntegrationStatus): { label: string; tone: TagTone } {
  switch (status) {
    case 'connected':
      return { label: 'Connected', tone: 'done' };
    case 'error':
      return { label: 'Needs reconnecting', tone: 'attention' };
    default:
      return { label: 'Not connected', tone: 'neutral' };
  }
}
