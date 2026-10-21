import type { LivePartialRegistrationDate } from '~/lib/registration/live-reading';

export interface RegistrationWindowContext {
  /** `Halton Hills`, as a parent says it. */
  town: string;
  /** What opens — `Fall 2026 recreation programs`. */
  programs: string;
  /** This family's applicable opening date/time, with the source's timezone. */
  opensFor: string;
  /** The residents-first date is theirs, so the general date is a different, later one. */
  residentsFirst: boolean;
  /** Current page's resident tier, independent of this family's eligibility. */
  residentOpens?: string | null;
  /** Current page's general/non-resident tier, even when it is this family's date. */
  generalOpens: string | null;
  /** Verified page date, but resident/non-resident applicability is not established. */
  unclassifiedOpens?: string | null;
  /** Fresh source facts whose complete calendar date is unresolved; never a reminder anchor. */
  partialDates?: LivePartialRegistrationDate[];
  note?: string | null;
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
import type { RegistrationOutcome, SequenceOptIn } from '~/lib/registration/sequence/schedule';

/** Watch-owned metadata only; no stored registration dates enter the coach context. */
export interface RegistrationWatchContext {
  id: string;
  town: string;
  programs: string;
  sourceUrl: string;
  optIn: SequenceOptIn;
  outcome: RegistrationOutcome | null;
}
