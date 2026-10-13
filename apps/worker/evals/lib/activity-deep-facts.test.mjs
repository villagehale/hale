import { describe, expect, it } from 'vitest';
import { DEEP_FIXTURES } from '../activity-deep-fixtures.mjs';
import {
  miscreditedDateFailures,
  notesForTheJudge,
  unreadScheduleFailures,
} from './activity-deep-facts.mjs';

const PROGRAMS = 'https://www.cartwheelsgymcentre.com/programs.php';
const HOME = 'https://www.cartwheelsgymcentre.com/';
const PDF = 'https://www.cartwheelsgymcentre.com/forms/Term_2_Schedule_2026-27.pdf';

const PROGRAMS_TEXT = `Cartwheels Programs
[Schedule at a glance](${PDF})
Tiny Gym (1 and walking to 3 years)`;

const HOME_TEXT =
  'Term 1/Fall registration is Wednesday July 22, 2026, at 8:00am for general programming.';

function liveEvidence(extra = '') {
  return {
    pages: [
      { url: PROGRAMS, text: PROGRAMS_TEXT },
      { url: HOME, text: HOME_TEXT },
    ],
    notes: `Opened the programs page.\n--- page: ${PROGRAMS} ---\n${PROGRAMS_TEXT}\n--- page: ${HOME} ---\n${HOME_TEXT}\n${extra}`,
  };
}

function slot(over) {
  return {
    name: 'Tiny Gym',
    when: null,
    price: null,
    registration: 'Term 1/Fall registration opened July 22 (per the home page).',
    sourceUrl: PROGRAMS,
    ...over,
  };
}

describe('a date is credited only to a page that was read', () => {
  it('fails when the date is not on the cited page', () => {
    const failures = miscreditedDateFailures([slot()], liveEvidence());
    expect(failures.some((failure) => failure.includes('july 22'))).toBe(true);
  });

  it('passes when the cited page is the home page that was fetched', () => {
    expect(
      miscreditedDateFailures(
        [slot({ sourceUrl: HOME, registration: 'Opened July 22.' })],
        liveEvidence(),
      ),
    ).toEqual([]);
  });

  it('fails when the field names the home page and that page was not fetched', () => {
    const evidence = {
      pages: [{ url: PROGRAMS, text: `${PROGRAMS_TEXT}\nRegistration opened July 22.` }],
      notes: 'programs only',
    };
    const failures = miscreditedDateFailures(
      [slot({ registration: 'Opened July 22 per the home page.' })],
      evidence,
    );
    expect(failures).toContain('miscredited_date:Tiny Gym:home page not read');
  });

  it('accepts the frozen programs page, where July 22 is on the cited page', () => {
    const fixture = DEEP_FIXTURES.find((item) => item.id === 'registration-in-plain-sight');
    const evidence = { pages: [{ url: '', text: fixture.notes }], notes: fixture.notes };
    expect(
      miscreditedDateFailures(
        [
          slot({
            when: 'Sundays 9:30, September 14 to October 26',
            price: '$124 per child',
            registration: 'Fall registration opened July 22 and runs until classes fill.',
            sourceUrl: PROGRAMS,
          }),
        ],
        evidence,
      ),
    ).toEqual([]);
  });
});

describe('a linked schedule document is opened or reported unread', () => {
  it('fails while the schedule PDF is unopened and unmentioned', () => {
    const failures = unreadScheduleFailures(
      [slot({ registration: 'Opened July 22.', sourceUrl: HOME })],
      liveEvidence(),
      'page_has_schedule',
    );
    expect(failures).toEqual(['unread_schedule:Term_2_Schedule_2026-27.pdf']);
  });

  it('passes when the pass says it could not read that document', () => {
    const saying = slot({
      sourceUrl: HOME,
      registration: 'Opened July 22. I could not read Term_2_Schedule_2026-27.pdf.',
    });
    expect(unreadScheduleFailures([saying], liveEvidence(), 'page_has_schedule')).toEqual([]);
  });

  it('passes when the document itself was fetched', () => {
    const evidence = liveEvidence();
    evidence.pages.push({ url: PDF, text: 'Tiny Gym Sundays 9:30' });
    expect(
      unreadScheduleFailures(
        [slot({ sourceUrl: HOME, registration: 'Opened July 22.' })],
        evidence,
        'page_has_schedule',
      ),
    ).toEqual([]);
  });

  it('does not apply when the pages publish no schedule', () => {
    expect(unreadScheduleFailures([slot()], liveEvidence(), 'page_has_no_schedule')).toEqual([]);
  });
});

describe('judge notes keep every fetched page', () => {
  it('leaves a short note unchanged', () => {
    const evidence = { notes: 'short', pages: [] };
    expect(notesForTheJudge(evidence)).toBe('short');
  });

  it('includes a later page once the notes pass the old slice', () => {
    const evidence = liveEvidence();
    evidence.notes = `${'x'.repeat(7000)}\n--- page: ${HOME} ---\n${HOME_TEXT}`;
    evidence.pages = [{ url: HOME, text: HOME_TEXT }];
    const shown = notesForTheJudge(evidence);
    expect(shown).toContain('July 22');
    expect(shown).toContain(HOME);
  });
});
