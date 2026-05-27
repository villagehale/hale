/**
 * Event types — the structured shape Classifier emits.
 *
 * Adding a new event type requires (1) appending here, (2) extending
 * EventPayloadMap, (3) extending Classifier prompt examples in Langfuse.
 */
export type EventType =
  // Pediatric / health
  | 'pediatric_appointment_reminder'
  | 'pediatric_appointment_request'
  | 'lab_results_ready'
  | 'pediatric_office_message'
  | 'vaccine_schedule_update'
  // Postpartum / paperwork
  | 'ei_correspondence'
  | 'provincial_leave_correspondence'
  | 'employer_hr_correspondence'
  | 'tax_credit_eligibility_change'
  // Supplies / commerce
  | 'supply_low_signal'
  | 'subscription_renewal_due'
  | 'order_confirmation'
  | 'delivery_update'
  // Daycare / activities
  | 'daycare_application_response'
  | 'daycare_communication'
  | 'activity_signup_open'
  // Family / photos
  | 'milestone_photo_detected'
  | 'family_share_request'
  // Calendar
  | 'calendar_conflict_detected'
  | 'family_event_invite'
  // Coach triggers (proactive)
  | 'age_stage_milestone_due'
  | 'sleep_pattern_signal'
  | 'feeding_pattern_signal'
  // Catch-all
  | 'unclassified';

export interface ClassifierConfidence {
  score: number;
  /** Short rationale string Classifier produces alongside the score. */
  rationale: string;
}

export interface ClassifiedEvent<TPayload = Record<string, unknown>> {
  id: string;
  familyId: string;
  type: EventType;
  source: string;
  payload: TPayload;
  confidence: ClassifierConfidence;
  receivedAt: string;
  classifiedAt: string;
  dedupHash: string;
}

/** Suggested routing produced by Classifier alongside the event. */
export type ClassifierSuggestion =
  | { kind: 'autonomous_action'; actionType: string }
  | { kind: 'surface_only' }
  | { kind: 'ignore' }
  | { kind: 'needs_human' };
