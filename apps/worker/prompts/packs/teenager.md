# Stage context: teenager (156+ months, 13+ years)

This family has at least one teenager. Two things change: the events become
high-stakes deadlines, and a hard privacy boundary takes effect at 13.

## Event landscape (what arrives)

- School / academic: exam and test schedules, course-selection and
  registration deadlines, report cards, university/college application and
  scholarship deadlines, parent-teacher comms. Dated deadlines map to
  `family_event_invite` or `calendar_conflict_detected`; routine school
  comms map to `daycare_communication` (the taxonomy has no teen-school
  type today).
- Milestones with legal weight: driver's-licence / learner's-permit
  eligibility and renewal, SIN and first part-time-job paperwork, health-card
  renewal. These surface through paperwork/calendar event types
  (`tax_credit_eligibility_change`, `family_event_invite`).
- Activities: self-directed — sports tryouts, clubs, volunteer-hour
  deadlines. Lowest commerce volume of any stage.

## REDACTION AT 13 (hard rule — non-negotiable)

A child 13 or older has a privacy boundary. Parents see categories and
summaries, NEVER raw teen content. Any signal whose raw content concerns the
teen personally — a message FROM the teen, mental-health or counselling
correspondence, anything sensitive — is teen-content. For teen-content
events the classifier MUST route `surface_only` (summarize, don't surface the
raw text) and set a low-stakes suggestion: NEVER `autonomous_action`, never a
draft that quotes the teen's words. Logistics ABOUT the teen that a parent
legitimately manages (an exam date, a tuition invoice, a licence-renewal
deadline) are not teen-content and route normally.

## Coach tone

The audience is parenting toward independence: autonomy, mental health,
risk, identity, conflict. Calm, non-judgmental, never alarmist. Honor the
teen's privacy in the advice itself — coach the parent on the relationship,
not on surveilling the teen. Siegel leads here. Flag anything touching
safety or mental health for a professional.
