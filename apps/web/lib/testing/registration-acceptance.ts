import { readFileSync } from 'node:fs';
import { resolveRepoFile } from '~/lib/coach/resolve-repo-file';
import { readCourseRegistration } from '~/lib/registration/live-reading';
import type { RegistrationReminderInput } from '~/lib/registration/sequence/compose';
import { readCoursePrep } from '~/lib/registration/sequence/prepare';
import { courseShortlist } from '~/lib/registration/sequence/shortlist';

/** Saved official HTML and an explicitly historical clock; no family DB or carrier. */
export const registrationAcceptanceCases = [
  ['open', 'en'],
  ['open', 'fr-CA'],
  ['full', 'en'],
  ['full', 'ar'],
  ['closing-soon', 'en'],
  ['closing-soon', 'fr-CA'],
  ['unconfirmed', 'en'],
  ['unconfirmed', 'ar'],
] as const;

export function registrationAcceptanceInput(
  state: string,
  language: string,
): RegistrationReminderInput {
  const now = new Date('2026-08-12T10:30:00Z');
  const timeZone = 'America/Toronto';
  const full = state === 'full';
  const courseId = full
    ? '85770d4d-bce9-4e53-b969-cf7e88775180'
    : '961140fe-0866-460f-9973-7c42cbe0a928';
  const sourceUrl = `https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=${courseId}`;
  const raw = readFileSync(
    resolveRepoFile(
      `apps/web/lib/channel/spots/fixtures/${full ? 'open-window-markham' : 'open-window-open-markham'}.html`,
    ),
    'utf8',
  );
  const reading = readCourseRegistration(
    { ok: true, raw },
    { sourceUrl, checkedAt: now, timeZone, courseId },
  );
  if (reading.status !== 'verified') throw new Error('Expected saved official registration facts');
  const verdict = readCoursePrep(
    { ok: true, raw },
    {
      courseId,
      timeZone,
      now,
      anchor: now,
      isResidentWindow: false,
      children: [],
      readinessReady: null,
    },
  );
  if (!('availability' in verdict) || verdict.availability?.state !== (full ? 'full' : 'open'))
    throw new Error('Saved availability drifted');
  const unavailable = state === 'unconfirmed';
  return {
    language,
    leg: state === 'closing-soon' ? 'waitlist_final' : unavailable ? 'heads_up' : 'go',
    resident: false,
    reading: unavailable
      ? {
          sourceUrl,
          checkedAt: now,
          timeZone,
          reader: 'perfectmind',
          status: 'unreadable',
          reason: 'fetch_failed',
        }
      : reading,
    change: unavailable
      ? {
          kind: 'unavailable',
          key: 'fixture',
          sourceUrl,
          previousAt: now.toISOString(),
          candidateAt: null,
          date: null,
          timeZone,
          status: 'unreadable',
          notified: false,
        }
      : null,
    copy: {
      shortlist: courseShortlist('local-test-watch', sourceUrl, now),
      now,
      timeZone,
      optIn: 'opted_in',
      anchor: now,
      portal: null,
      readinessReady: null,
      prep: unavailable ? null : { courseUrl: sourceUrl, verdict },
      ...(state === 'closing-soon'
        ? { waitlist: { position: 2, deadlineAt: new Date('2026-08-12T11:00:00Z') } }
        : {}),
    },
  };
}
