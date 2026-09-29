/**
 * Placeholder year-retention lines (ENG-1).
 *
 * Sloane design-locks these later. Callers load them from here and do not
 * inline their own — swapping the wording is a change to this file only.
 * The paid part is keeping Hale for the year. It is not an assistant plan.
 */
export const YEAR_RETENTION_COPY = {
  ask: 'The finds and follow-ups stay free. Keeping Hale for the year is the paid part — want the link?',
  link: (url: string) => `Here's the link to keep Hale for the year: ${url}`,
  declined: 'All good — the free side stays as it is.',
  notReady: "The year link isn't ready yet. I'll send it when it is.",
  alreadyPaid: "You're already set for the year.",
  groupSyncYes: "They're keeping Hale for the year.",
  groupSyncNo: "They're staying on the free side.",
} as const;
