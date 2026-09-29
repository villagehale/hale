/**
 * Design-locked EN strings (Sloane 2026-09-28).
 *
 * Callers load them from here and do not inline their own. FR twins are
 * locked in the PR comment for when locale exists (1:1=tu, group=vous).
 * They are not wired in this file yet.
 */
export const YEAR_RETENTION_COPY = {
  ask: "Want to keep the kids' year going with me? Finds stay free.",
  link: (url: string) => `Here's the year link: ${url}`,
  declined: 'All good — finds stay free.',
  notReady: "The year link isn't ready yet. I'll send it when it is.",
  alreadyPaid: "You're already set for the year.",
  groupSyncYes: "They're keeping Hale for the year.",
  groupSyncNo: "They're staying on free finds.",
} as const;
