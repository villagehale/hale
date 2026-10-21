import { registrationDate, registrationWhen } from '~/lib/registration/read';
import type { RegistrationReminderInput } from '~/lib/registration/sequence/compose';
import { readinessClause, renderSequenceLeg } from '~/lib/registration/sequence/copy';
import {
  type RegistrationLinkReplyInput,
  registrationLinkReplyContext,
} from '~/lib/registration/sequence/link-reply';
import { registrationChangeBody } from '~/lib/registration/sequence/refresh';

/** Structured facts only: a handler-mechanics double, never real AI wording. */
export async function registrationLinkReplyFixture(
  input: RegistrationLinkReplyInput,
): Promise<string> {
  return JSON.stringify(registrationLinkReplyContext(input));
}

/** Legacy wording makes cron-mechanics fixtures stable, not an AI-copy quality claim. */
export async function registrationReminderFixture({
  leg,
  reading,
  resident,
  copy: input,
  change,
}: RegistrationReminderInput): Promise<string> {
  if (change) return registrationChangeBody(change);
  if (leg === 'waitlist_half' || leg === 'waitlist_final') return renderSequenceLeg(leg, input);
  const date = registrationDate(reading, resident);
  if (!date) throw new Error('fixture: missing live date');
  const when = registrationWhen(reading, date);
  const source = reading.sourceUrl;
  if (
    date.time !== null &&
    input.portal !== null &&
    (leg === 'readiness' || leg === 'battle_plan' || leg === 'go')
  )
    return `${renderSequenceLeg(leg, { ...input, timeZone: reading.timeZone!, shortlist: { ...input.shortlist, sourceUrl: source } })} (${reading.timeZone})`;
  if (leg === 'heads_up')
    return `The registration page says ${when}. ${input.optIn === 'opted_in' ? "I'll send a reminder the evening before." : 'Confirm the reminder plan in your approvals to get the full reminders.'} ${source}`;
  if (leg === 'readiness' || leg === 'battle_plan')
    return `Registration is ${when}. Have your login and this page ready. ${input.portal ? readinessClause(input.readinessReady, 'evening') : ''} ${source}`;
  if (leg === 'go') return `Registration opens at ${when}. Your link: ${source}`;
  return 'How did registration go? Reply "got in", "waitlisted #12" or "missed it".';
}
