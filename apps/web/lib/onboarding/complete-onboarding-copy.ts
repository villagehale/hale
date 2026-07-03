/**
 * Human copy for a {@link CompleteOnboardingResult} `invalid` error code. The
 * server action returns machine codes (tos_required, dob_future, …); the finish
 * button must never render one raw at the user. Every known code maps to a plain
 * sentence in the wizard's lowercase voice; an unknown code degrades to a generic
 * line rather than leaking the underscored code.
 */
const ERROR_COPY: Record<string, string> = {
  tos_required: 'agree to the Terms of Service and Privacy Policy to finish.',
  plan_invalid: "that plan isn't available — pick one of the options above.",
  name_required: 'add at least one child to finish.',
  dob_required: 'add each child’s date of birth.',
  dob_invalid: "one of the birthdays doesn't look right — check the date.",
  dob_future: 'a birthday is in the future — check the year.',
  dob_too_old: 'Hale is for children under eighteen.',
};

export function describeCompleteOnboardingError(error: string): string {
  return ERROR_COPY[error] ?? 'something went wrong — please try again.';
}
