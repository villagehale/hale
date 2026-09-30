import { describe, expect, it } from 'vitest';
import { assistedHandoffLine, collapseSignupFact } from './handoff';

describe('assisted handoff call site', () => {
  it('trims the session label and pack values before the locked line', () => {
    expect(
      assistedHandoffLine({
        link: 'https://www.toronto.ca/register',
        sessionLabel: '  Tue   4:30 \n',
        pack: [{ slot: 'parent_first_name', value: '  Test   Parent  ' }],
      }),
    ).toBe(
      `This one has to be done by you. Here's the page: https://www.toronto.ca/register\nFor Tue 4:30, you'll want parent_first_name: Test Parent.`,
    );
  });

  it('collapses a session label before the completed line is built', () => {
    expect(collapseSignupFact('  Tue   4:30 \n')).toBe('Tue 4:30');
  });
});
