import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNTRUSTED_CLOSE } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import {
  type EmailAlertNoticeFacts,
  emailAlertNoticeUserMessage,
} from '~/lib/integrations/email-alert-notice';
import { eventNotesUserMessage } from '~/lib/integrations/event-notes';
import { classAvailabilityInput } from '~/lib/registration/class-availability';
import { extractionInput } from '~/lib/registration/verify-window';

/**
 * VIL-560 · untrusted email, calendar and web fields enter a prompt through the
 * shared mark, always on, with the same tags in every lane.
 */

const WEB_LIB = join(dirname(fileURLToPath(import.meta.url)), '..');

const LANES = [
  'sentinel/triage.ts',
  'sentinel/extract.ts',
  'pipeline/classify.ts',
  'pipeline/draft.ts',
  'integrations/email-alert-notice.ts',
  'integrations/event-notes.ts',
  'registration/verify-window.ts',
  'registration/class-availability.ts',
  'cron/inference-tools.ts',
  'channel/coach/read-email-tool.ts',
];

describe('VIL-560 · every untrusted inbound lane uses the shared mark', () => {
  it('each production lane imports markUntrusted or markUntrustedTree', () => {
    for (const rel of LANES) {
      const source = readFileSync(join(WEB_LIB, rel), 'utf8');
      expect(source, rel).toMatch(/\bmarkUntrusted(?:Tree)?\b/);
    }
  });
});

describe('VIL-560 · exported user messages mark the untrusted fields', () => {
  it('event notes, registration page and class page wrap the untrusted fields and keep Hale-owned keys bare', () => {
    const notes = JSON.parse(eventNotesUserMessage('Swim', 'Use the back lot')) as {
      title: string;
      description: string;
    };
    expect(notes.title).toContain('source="calendar" field="title"');
    expect(notes.title).toContain('Swim');
    expect(notes.title.endsWith(UNTRUSTED_CLOSE)).toBe(true);
    const page = JSON.parse(
      extractionInput(
        { municipality: 'toronto', programDomain: 'swim', cycleLabel: 'Fall 2026' },
        '<p>opens Nov 10</p>',
      ),
    ) as { municipality: string; page_text: string };
    expect(page.municipality).toBe('toronto');
    expect(page.page_text).toContain('source="web" field="page_text"');
    const cls = JSON.parse(classAvailabilityInput({ label: 'Tue swim', anchor: null }, 'Full')) as {
      class_label: string;
      session_anchor: null;
      page_text: string;
    };
    expect(cls.class_label).toBe('Tue swim');
    expect(cls.session_anchor).toBeNull();
    expect(cls.page_text).toContain('source="web" field="page_text"');
  });
});

describe('emailAlertNoticeUserMessage', () => {
  const facts = {
    now: { date: 'Tuesday, November 10, 2026', time: '9:00 AM' },
    children: [{ name: 'Robin', ageYears: 3 }],
    email: {
      sender: 'Maple Daycare',
      arrivedOn: 'Monday, November 9, 2026',
      subject: 'Picture day',
      kind: 'new_event' as const,
      title: 'Picture day',
      namedChild: 'Robin',
      was: null,
      when: { date: 'Friday, November 13, 2026', time: '9:00 AM' },
      durationMinutes: null,
      location: 'the gym',
    },
    fromParentsOwnCalendar: false,
    alreadyOnCalendar: false,
    offer: null,
    otherHaleFamiliesGoing: null,
    private: false,
    language: 'en',
    recentNotices: [] as string[],
  } satisfies EmailAlertNoticeFacts;

  it('wraps the email’s own strings and leaves the kind bare', () => {
    const parsed = JSON.parse(emailAlertNoticeUserMessage(facts)) as {
      email: { sender: string; kind: string; title: string };
      children: { name: string }[];
    };
    expect(parsed.email.kind).toBe('new_event');
    expect(parsed.children[0]?.name).toBe('Robin');
    expect(parsed.email.sender).toContain('source="email" field="sender"');
    expect(parsed.email.title).toContain('Picture day');
  });
});
