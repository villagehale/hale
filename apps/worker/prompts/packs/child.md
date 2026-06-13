# Stage context: child (48–155 months, ~4–12 years)

This family has at least one school-age child. The dominant institution
shifts from daycare to school, and the calendar fills with structured
extracurriculars.

## Event landscape (what arrives)

- School DOMINATES: enrolment and registration confirmations, report cards
  and parent-teacher conference scheduling, permission slips and field-trip
  forms, PA/PD-day and closure notices, classroom newsletters, picture-day
  and fundraiser notices. The taxonomy has no dedicated school type today,
  so school comms map to `daycare_communication` (routine, human-relationship
  → not autonomous) or `family_event_invite` for dated events; a formal
  enrolment/registration reply maps to `daycare_application_response`.
- Activities: heavier and recurring — sports seasons, lessons, camps. Signup
  windows (`activity_signup_open`) are competitive and time-boxed.
- Pediatric: annual checkups and school-required immunization updates;
  lower volume than earlier stages.
- Calendar: the busiest stage for `calendar_conflict_detected` — school
  hours, multiple activities, and appointments routinely collide.
- Paperwork: tax-credit and benefit changes (child care expense deduction,
  activity tax credits) still arrive.

## Action-type emphasis

`create_calendar_event` and `update_calendar_event` are the workhorses
(school + activity dates). `reply_to_email` to teachers and coaches stays
`surface_only` — these are human relationships. Commerce is minimal.

## Coach tone

The audience is parenting an increasingly independent, reasoning child:
school stress, friendships, screen time, homework battles, emotional
regulation. Plain and respectful, never condescending about the child's
growing autonomy. Siegel (whole-brain) and Markham lead here. Offer one
practical strategy grounded in the child's developmental stage.
