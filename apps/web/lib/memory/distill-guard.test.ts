import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guardChatDistilledFact } from './distill-guard';

/**
 * 2026-10-01 ~06:43 ET. Intake handed the parent a suggestion list. The chat
 * distiller stored it as a live `children_age_range` fact whose summary said the
 * range was "based on enrollment", and a later reply told the parent they were
 * starting those classes. No activity_bookings row and no family_events row
 * existed.
 *
 * The list is the shape `renderWeekFind` actually sends: numbered picks, no
 * enrollment verb. The parent had only given names, ages, and a town.
 */
const SUGGESTION_LIST = [
  '1. Tiny Dancers (2-4 years) - Oct 3',
  '2. Parent & Tot Swimming (18 months-3 years) - Oct 3',
].join('\n');

const PARENT_INTAKE = 'Maya is 3 and Leo is 1. We are in Burlington.';

const INCIDENT_SUMMARY =
  'Children are 2-4 based on enrollment in Tiny Dancers and Parent & Tot Swimming starting Oct 3';

const incidentTurns = [
  { role: 'user' as const, content: PARENT_INTAKE },
  { role: 'assistant' as const, content: SUGGESTION_LIST },
];

describe('guardChatDistilledFact — 2026-10-01 suggestion list stored as enrollment', () => {
  it('drops children_age_range when the summary treats a found list as enrollment and nothing is booked', () => {
    const decision = guardChatDistilledFact({
      factKey: 'children_age_range',
      summary: INCIDENT_SUMMARY,
      turns: incidentTurns,
      receipts: [],
    });

    expect(decision).toEqual({ action: 'drop', reason: 'ungrounded_enrollment' });
  });

  it('drops the same classes when the summary says they are starting, without using the word enrolled', () => {
    const decision = guardChatDistilledFact({
      factKey: 'children_age_range',
      summary: 'Starting Tiny Dancers and Parent & Tot Swimming on Oct 3',
      turns: incidentTurns,
      receipts: [],
    });

    expect(decision).toEqual({ action: 'drop', reason: 'assistant_suggestion' });
  });

  it('drops a "your pick" fact built from the suggestion list', () => {
    const decision = guardChatDistilledFact({
      factKey: 'your_pick',
      summary: 'Your pick is Tiny Dancers',
      turns: incidentTurns,
      receipts: [],
    });

    expect(decision.action).toBe('drop');
  });

  it('drops enrollment wording even when the parent said the words, until a booking or event row backs them', () => {
    const decision = guardChatDistilledFact({
      factKey: 'swim_class',
      summary: 'They signed up for Parent & Tot Swimming',
      turns: [
        { role: 'user', content: 'We signed up for Parent & Tot Swimming' },
        { role: 'assistant', content: SUGGESTION_LIST },
      ],
      receipts: [],
    });

    expect(decision).toEqual({ action: 'drop', reason: 'ungrounded_enrollment' });
  });

  it('keeps enrollment wording when a live booking title is the same class', () => {
    const decision = guardChatDistilledFact({
      factKey: 'swim_class',
      summary: 'Enrolled in Parent & Tot Swimming',
      turns: incidentTurns,
      receipts: [{ title: 'Parent & Tot Swimming' }],
    });

    expect(decision).toEqual({ action: 'keep' });
  });

  it('does not treat an unrelated event as backing for a different class', () => {
    const decision = guardChatDistilledFact({
      factKey: 'children_age_range',
      summary: INCIDENT_SUMMARY,
      turns: incidentTurns,
      receipts: [{ title: 'Parent night at school' }],
    });

    expect(decision).toEqual({ action: 'drop', reason: 'ungrounded_enrollment' });
  });

  it('keeps a fact the parent actually said', () => {
    const decision = guardChatDistilledFact({
      factKey: 'naps',
      summary: 'Maya naps at 1',
      turns: [...incidentTurns, { role: 'user', content: 'Maya naps at 1 these days' }],
      receipts: [],
    });

    expect(decision).toEqual({ action: 'keep' });
  });

  it('rewrites a mixed summary so the parent fact stays and the unbooked class does not', () => {
    const decision = guardChatDistilledFact({
      factKey: 'naps',
      summary: 'Maya naps at 1. She is enrolled in Tiny Dancers.',
      turns: [
        { role: 'user', content: 'Maya naps at 1' },
        { role: 'assistant', content: SUGGESTION_LIST },
      ],
      receipts: [],
    });

    expect(decision).toEqual({
      action: 'rewrite',
      summary: 'Maya naps at 1.',
      reason: 'stripped_ungrounded_enrollment',
    });
  });
});

describe('infer-memory skill — suggestion lists are not enrollments', () => {
  const skill = readFileSync(
    fileURLToPath(new URL('../../../../packages/agent/skills/infer-memory.md', import.meta.url)),
    'utf8',
  );

  it('tells the distiller to save only what the parent said or confirmed', () => {
    expect(skill).toMatch(/parent said or confirmed/i);
    expect(skill).toMatch(/found/i);
    expect(skill).toMatch(/your pick/i);
  });

  it('forbids enrollment words in a summary unless a booking or event backs them', () => {
    expect(skill).toMatch(/enrolled/);
    expect(skill).toMatch(/enrollment/);
    expect(skill).toMatch(/signed up/);
    expect(skill).toMatch(/booked/);
    expect(skill).toMatch(/registered/);
  });
});
