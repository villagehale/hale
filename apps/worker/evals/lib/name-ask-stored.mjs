// The onboarding state the name-ask fixtures are recorded against: a family
// mid-onboarding with place, kids and ages stored, nothing else answered yet.
// Production reads this from the family's session (nameAskChecklist).
export const NAME_ASK_STORED = {
  postal: true,
  kids: true,
  ages: true,
  name: false,
  gmail: false,
  calendar: false,
  schedule: false,
  coparent: false,
};
