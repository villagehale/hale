import { describe, expect, it } from 'vitest';
import { signupAssistedHandoffLine, signupCompletedLine, signupHandbackLine } from './copy';

/**
 * Sloane's locked English, byte for byte, from the design comment on PR #720.
 * The sentence that offers to book is not in this file.
 */
describe('authorized signup copy', () => {
  it('reports a completed signup with the session label', () => {
    expect(signupCompletedLine('Tue 4:30')).toBe(`You're signed up for Tue 4:30.`);
  });

  it.each([
    ['not_authorized', 'I need your okay on that one first.'],
    ['no_offer', `I don't have a signup to finish for that yet.`],
    ['ambiguous_session', `I can't tell which session you mean. Which one?`],
    ['session_full', 'That session is full.'],
    ['session_not_offered', `I couldn't find that session.`],
    ['price_not_approved', 'The price is more than you said yes to.'],
    ['price_change', 'The price changed, so I stopped.'],
    ['payment', `It's asking for payment, so that part is yours.`],
    ['captcha', `It wants a "not a robot" check, so that one's yours.`],
    ['login_wall', 'It wants you to log in, so I stopped.'],
    ['waiver', `There's a waiver to read and sign, so that part's yours.`],
    ['medical', `It asks about health or allergies, so that's yours to answer.`],
    ['allergy', `It asks about health or allergies, so that's yours to answer.`],
    ['waiting_room', `It has a waiting room, so you'll need to be in it yourself.`],
    ['resident_verification', `It needs to verify you live there, so that's yours.`],
    ['timed_open', `Registration isn't open yet.`],
    ['unexpected_field', `The form asks something I wasn't expecting, so I stopped.`],
    ['missing_detail', `I'm missing a detail it asks for.`],
    ['teen_privacy', `It asks for a teen's details, so it's yours to fill in.`],
    ['unconfirmed', `I didn't see a confirmation page, so don't count on it yet.`],
    ['connector_failed', `I couldn't get through on my end.`],
    ['browser_unavailable', `I couldn't get through on my end.`],
    ['url_refused', `I couldn't get through on my end.`],
    ['redirect', `I couldn't get through on my end.`],
    ['already_in_progress', 'I stopped before finishing.'],
    ['would_initiate_1_1', 'I stopped before finishing.'],
  ])('states %s and nothing else when there is no link and nothing was filled', (reason, line) => {
    expect(signupHandbackLine({ reason, link: '', prefilled: [] })).toBe(line);
  });

  it('adds the page, then the filled fields, as one message', () => {
    expect(
      signupHandbackLine({
        reason: 'payment',
        link: 'https://example.test/pay',
        prefilled: ['parent_email', 'postal_code', 'session'],
      }),
    ).toBe(
      `It's asking for payment, so that part is yours. Here's the page: https://example.test/pay I filled in parent_email, postal_code, and session.`,
    );
  });

  it('omits the page sentence when the link is empty and the filled sentence when nothing was filled', () => {
    expect(signupHandbackLine({ reason: 'session_full', link: '', prefilled: ['session'] })).toBe(
      'That session is full. I filled in session.',
    );
    expect(
      signupHandbackLine({
        reason: 'price_change',
        link: 'https://example.test/tickets',
        prefilled: [],
      }),
    ).toBe(`The price changed, so I stopped. Here's the page: https://example.test/tickets`);
  });

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
