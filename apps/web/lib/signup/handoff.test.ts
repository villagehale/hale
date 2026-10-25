import { describe, expect, it } from 'vitest';
import { assistedHandoffReply, collapseSignupFact } from './handoff';
import { echoOutcomeWriter } from './test-models';

describe('assisted handoff (reply model, mocked)', () => {
  it('passes the collapsed facts to the reply model and sends what it writes', async () => {
    const writer = echoOutcomeWriter();
    const text = await assistedHandoffReply(writer, {
      link: 'https://www.toronto.ca/register',
      sessionLabel: '  Tue   4:30 \n',
      pack: [{ slot: 'parent_first_name', value: '  Test   Parent  ' }],
    });
    expect(writer.facts[0]).toMatchObject({
      outcome: 'assisted_handoff',
      confirmed: false,
      sessionLabel: 'Tue 4:30',
      link: 'https://www.toronto.ca/register',
      pack: [{ slot: 'parent_first_name', value: 'Test Parent' }],
    });
    expect(text).toContain('outcome=assisted_handoff');
  });

  it('sends nothing when the model writes nothing: no fixed fallback', async () => {
    await expect(
      assistedHandoffReply(
        { write: async () => null },
        { link: 'https://x.test', sessionLabel: 'Tue', pack: [] },
      ),
    ).resolves.toBeNull();
  });

  it('collapses a padded fact', () => {
    expect(collapseSignupFact('  Tue   4:30 \n')).toBe('Tue 4:30');
  });
});
