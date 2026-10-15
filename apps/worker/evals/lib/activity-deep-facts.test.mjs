import { describe, expect, it } from 'vitest';
import { notesForTheJudge } from './activity-deep-facts.mjs';

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
