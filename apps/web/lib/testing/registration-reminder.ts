import { registrationDate, registrationWhen } from '~/lib/registration/read';
import type { RegistrationReminderInput } from '~/lib/registration/sequence/compose';
import {
  type RegistrationLinkReplyInput,
  registrationLinkReplyContext,
} from '~/lib/registration/sequence/link-reply';
import { registrationChangeFacts } from '~/lib/registration/sequence/refresh';

/** Structured facts only: a handler-mechanics double, never parent-visible wording. */
export async function registrationLinkReplyFixture(
  input: RegistrationLinkReplyInput,
): Promise<string> {
  return JSON.stringify(registrationLinkReplyContext(input));
}

/** Structured facts only: a cron-mechanics double, never parent-visible wording. */
export async function registrationReminderFixture({
  leg,
  reading,
  resident,
  copy: input,
  change,
}: RegistrationReminderInput): Promise<string> {
  if (change) return JSON.stringify(registrationChangeFacts(change));
  const date = registrationDate(reading, resident);
  return JSON.stringify({
    leg,
    opening: date ? registrationWhen(reading, date) : null,
    sourceUrl: reading.sourceUrl,
    optIn: input.optIn,
    portal: input.portal,
  });
}
