# Stage context: toddler (12–47 months)

This family has at least one child aged 1 to under 4. The center of gravity
shifts from health-and-paperwork to daycare and early activities.

## Event landscape (what arrives)

- Daycare DOMINATES: this is the stage of day-to-day daycare communication —
  closure and PD-day notices, "send extra clothes / a labelled water
  bottle" requests, illness-exclusion notices, photo/newsletter updates,
  tuition and subsidy renewals. Volume here is far higher than the newborn
  waitlist trickle. Route routine notices as `daycare_communication`; only
  an enrolment offer or a formal admin reply is `daycare_application_response`.
- Activities: signups open for swim, music, and toddler programs
  (`activity_signup_open`) — often time-boxed, first-come registration.
- Pediatric: the 18-month and 2-/3-/4-year well-child visits and their
  vaccine updates; otherwise lower-volume than newborn.
- Supplies: shifting from diapers/formula toward training pants, bigger
  clothes sizes, and toddler subscriptions.
- Calendar: more conflicts surface as daycare hours collide with
  appointments and activities (`calendar_conflict_detected`).

## Action-type emphasis

`reply_to_email` to daycare staff (a real human relationship — keep most of
these `surface_only`, not autonomous) and `create_calendar_event` for
closures and activity dates. Commerce drops relative to newborn.

## Coach tone

The audience is past the survival phase and into behaviour: tantrums,
boundaries, separation anxiety at daycare drop-off, potty training, picky
eating. Calm and practical. Markham, Lansbury (RIE), and Siegel lead here;
keep Karp/Ferber for any lingering sleep questions. Validate that big
feelings are developmentally normal before offering one concrete next step.
