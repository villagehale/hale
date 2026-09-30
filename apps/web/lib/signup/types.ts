/** A public time slot on the offer. `label` is what a parent can name. */
export interface SignupSession {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  full: boolean;
  priceCents: number | null;
  /** Parent-approved headcount. Absent means a party-size field cannot be filled. */
  partySize?: number | null;
  /**
   * Parent-approved seating or table note. Absent means the field stays blank.
   * Health, contact, and waiver text are refused before they are stored.
   */
  seatingNote?: string | null;
}

export interface SignupOffer {
  id: string;
  familyId: string;
  childId: string;
  activityKey: string;
  registrationUrl: string;
  sessions: SignupSession[];
  approvedPriceCents: number | null;
}

export interface BusyInterval {
  startsAt: string;
  endsAt: string;
}

/** Details read from the family record at fill time. Never written to audit or logs. */
export interface SignupIdentity {
  childFirstName: string | null;
  childLastName: string | null;
  /** Set only when the stored date of birth is exact, not derived from an age. */
  childDob: string | null;
  parentFirstName: string | null;
  parentEmail: string | null;
  postalCode: string | null;
  teenager: boolean;
}

export type FieldSlot =
  | 'child_first_name'
  | 'child_last_name'
  | 'child_dob'
  | 'parent_first_name'
  | 'parent_email'
  | 'postal_code'
  | 'session'
  | 'visit_date'
  | 'party_size'
  | 'seating_note';

export interface PageOption {
  value: string;
  label: string;
  disabled: boolean;
}

export interface PageControl {
  name: string;
  type: string;
  required: boolean;
  label: string;
  autocomplete: string | null;
  options: PageOption[];
}

export interface PageSnapshot {
  href: string;
  controls: PageControl[];
  /** Distinct prices found on the page, in cents. Empty when the page states none. */
  priceCents: number[];
  captcha: boolean;
  confirmed: boolean;
  /**
   * Text inside the registration form, used only to notice a waiver, medical,
   * or allergy form. Never written to the audit trail.
   */
  formText: string;
  /** A Queue-it style waiting room or queue. The runner does not click through one. */
  waitingRoom: boolean;
  /** Resident or identity verification. A rush-registration exclusion, any host. */
  residentVerification?: boolean;
  /** Timed open-at registration. A rush-registration exclusion, any host. */
  timedOpen?: boolean;
  /**
   * The primary submit button's text. "Continue" advances a cart. A missing
   * label is treated as the final step.
   */
  submitLabel?: string | null;
}

export type SignupStopReason =
  | 'not_authorized'
  | 'no_offer'
  | 'ambiguous_session'
  | 'session_full'
  | 'session_not_offered'
  | 'price_not_approved'
  | 'price_change'
  | 'connector_failed'
  | 'payment'
  | 'captcha'
  | 'login_wall'
  | 'waiver'
  | 'medical'
  | 'allergy'
  | 'waiting_room'
  | 'resident_verification'
  | 'timed_open'
  | 'assisted_handoff'
  | 'unexpected_field'
  | 'missing_detail'
  | 'teen_privacy'
  | 'browser_unavailable'
  | 'redirect'
  | 'unconfirmed'
  | 'url_refused'
  | 'already_in_progress'
  | 'would_initiate_1_1';

export interface SignupPage {
  snapshot(): Promise<PageSnapshot>;
  fill(name: string, value: string): Promise<void>;
  select(name: string, value: string): Promise<void>;
  /** Advance a multi-step cart. Does not treat the page as a finished booking. */
  continue(): Promise<void>;
  submit(): Promise<void>;
  close(): Promise<void>;
}

export interface SignupBrowser {
  open(url: string): Promise<SignupPage>;
}
