export interface RegistrationWindowContext {
  /** `Halton Hills`, as a parent says it. */
  town: string;
  /** What opens — `Fall 2026 recreation programs`. */
  programs: string;
  /** This family's applicable opening date/time, with the source's timezone. */
  opensFor: string;
  /** The residents-first date is theirs, so the general date is a different, later one. */
  residentsFirst: boolean;
  /** Set only when it differs from `opensFor` — the date everyone else gets. */
  generalOpens: string | null;
  /** The match rests on the ±6-month tolerance around a derived DOB, so hedge the band. */
  ageApproximate: boolean;
  /**
   * An approved watch is active. Date-only sources cannot support a minute reminder;
   * reminderState distinguishes a paused watch from an unapproved proposal.
   */
  watching: boolean;
  sourceUrl?: string;
  reminderState?: 'active' | 'awaiting_confirmation' | 'paused';
  minuteReminderAvailable?: boolean;
}
