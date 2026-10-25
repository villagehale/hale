import { describe, expect, it } from 'vitest';
import { signupAssistedHandoffLine } from './copy';

/** The assisted handoff line. Completed and stopped replies are model-written (outcome-reply.ts). */
describe('authorized signup copy', () => {
  it('hands a municipal page back in two lines, and skips the pack line when the pack is empty', () => {
    expect(
      signupAssistedHandoffLine({
        link: 'https://www.toronto.ca/register',
        sessionLabel: 'Tue 4:30',
        pack: [
          { slot: 'child_first_name', value: 'Ada' },
          { slot: 'postal_code', value: 'M5V2T6' },
        ],
      }),
    ).toBe(
      `This one has to be done by you. Here's the page: https://www.toronto.ca/register\nFor Tue 4:30, you'll want child_first_name: Ada, postal_code: M5V2T6.`,
    );
    expect(
      signupAssistedHandoffLine({
        link: 'https://www.toronto.ca/register',
        sessionLabel: 'Tue 4:30',
        pack: [],
      }),
    ).toBe(`This one has to be done by you. Here's the page: https://www.toronto.ca/register`);
  });
});
