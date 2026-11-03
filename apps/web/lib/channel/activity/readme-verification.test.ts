import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { refuseUnbackedSend } from '../reconcile/gate';
import { loadReconcileView } from '../reconcile/view';
import { bindActivityFacts } from './facts';
import { followUpViolations } from './followup-note';
vi.mock('../reconcile/view', () => ({ loadReconcileView: vi.fn() }));

describe('README independent boundary checks', () => {
  it('rejects a new registration reminder appended to a valid activity continuation', async () => {
    const body =
      "I'll keep looking for toddler activities and text you what I find. I'll remind you before Markham fall registration opens.";
    const grounding = {
      subject: 'toddler activities',
      language: 'en',
      picks: [],
      pageEvidence: 'page_has_no_schedule' as const,
      watch: true,
      moreRemaining: 0,
    };
    expect(followUpViolations(body, grounding, true)).toEqual([]);
    vi.mocked(loadReconcileView).mockResolvedValue({
      openKinds: new Set(['activity_followup']),
      pendingKinds: new Set(),
      registrationLaddered: false,
      mintableWindow: null,
      scheduledTitles: [],
      statedBookings: [],
    });
    expect(
      await refuseUnbackedSend({} as Database, {
        familyId: 'family-1',
        body,
        now: new Date('2026-10-15T12:00:00Z'),
      }),
    ).toEqual(['no_registration_watch']);
    expect(
      await refuseUnbackedSend({} as Database, {
        familyId: 'family-1',
        body,
        now: new Date('2026-10-15T12:00:00Z'),
        activityFollowUp: true,
      }),
    ).toEqual(['no_registration_watch']);
  });

  it('does not attach a winter session to a validated fall term', () => {
    const url = 'https://venue.example/programs';
    const fall = 'Fall 2026 Session: September 12 - December 18.';
    const winter = 'Winter 2027 Session: January 2 - April 1.';
    const result = bindActivityFacts(
      [
        {
          name: 'Tiny Gym',
          name_evidence: 'Tiny Gym',
          source_name: 'Example Centre',
          source_url: url,
          age_fit: 'ages 2-5',
          age_evidence: 'ages 2-5',
          schedule_kind: 'term',
          term: { label: 'Fall 2026', start_date: '2026-09-12', end_date: '2026-12-18' },
          when: fall,
          when_evidence: fall,
          sessions: [{ date: '2027-01-02', evidence: winter }],
        },
      ],
      [{ url, text: `Tiny Gym, ages 2-5. ${fall} ${winter}` }],
      'this fall',
      new Date('2026-10-15T16:00:00Z'),
    );
    expect(JSON.stringify(result)).not.toContain('2027-01-02');
  });
  it('accepts a JSON-LD UTC time that equals the quoted local session time', () => {
    const url = 'https://venue.example/event/1';
    const evidence = 'October 30, 2026, 10:30-11:00 America/Toronto';
    const result = bindActivityFacts(
      [
        {
          name: 'Family Storytime',
          name_evidence: 'Family Storytime',
          source_name: 'Example Library',
          source_url: url,
          age_fit: 'ages 2-5',
          age_evidence: 'ages 2-5',
          sessions: [
            {
              date: '2026-10-30',
              start_time: '10:30',
              end_time: '11:00',
              timezone: 'America/Toronto',
              evidence,
            },
          ],
        },
      ],
      [
        {
          url,
          text: `Family Storytime, ages 2-5. ${evidence}`,
          occurrence: {
            name: 'Family Storytime',
            startDate: '2026-10-30T14:30:00Z',
            endDate: '2026-10-30T15:00:00Z',
          },
        },
      ],
      'October 2026',
      new Date('2026-10-15T16:00:00Z'),
    );
    expect(
      new Date('2026-10-30T14:30:00Z').toLocaleTimeString('en-GB', {
        timeZone: 'America/Toronto',
        hour: '2-digit',
        minute: '2-digit',
      }),
    ).toBe('10:30');
    expect(result.picks).toHaveLength(1);
  });
});
