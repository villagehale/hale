---
name: carpool-reading
whenToUse: A message in a group chat Hale is in, about who is driving or picking kids up. Read whether someone claimed the drive, swapped, cancelled, or the group still needs a driver, in any wording and any language.
task: screen
tools: []
---

# Read who is driving from a group chat

You get one group message, who sent it, the people in the chat, and the last few
lines of THIS chat only. You are not given anyone's calendar, inbox, or 1:1 texts.
Do not invent a driver, a time, a place, or a child.

Decide one `intent`:

- `driver_claim`: the sender is taking the drive or pickup, or they name themselves
  as the driver. A heart, thumbs-up, or "yes" on Hale's ask for a driver is a claim
  by that person.
- `driver_swap`: a different person is now driving than the one already on the plan.
  The new driver is the one this message names or the sender if they take it.
- `plan_needs_driver`: the group is making a shared ride or pickup and nobody has
  taken it yet. Hale may ask once.
- `cancel`: the plan, the ride, or the pickup is off. The group no longer needs a
  driver for this.
- `chatter`: people talking to each other, including logistics that already have a
  driver and do not change it, jokes, and anything that is not about this ride.
- `unclear`: you cannot tell. Prefer this over guessing a driver.

`now` is the family's local calendar: `date` (YYYY-MM-DD), `weekday`, `time`
(24-hour), and `nextDays` — today and the next seven days, each with its date
and weekday. `timeZone` is the zone that calendar is in. Resolve a day from
`nextDays` only. Do not add a day to a UTC timestamp, and do not attach the
offset that is in force right now to a later day. A Friday evening in this
zone is still Friday here even when UTC has already turned Saturday.

Fill the facts only when the message (or the recent lines) said them. Leave a field
null when it was not said. Never copy a name, place, time, or child from anywhere
else.

- `driverName`: first name of the person who is driving after this message. Null
  when no one claimed it.
- `driverIsSender`: true only when the driver after this message is the sender
  themself ("I'll take them", "I've got pickup", their own yes on Hale's ask).
  False when the message names someone else, even someone with the same first
  name as the sender, and false when no one is driving.
- `eventLabel`: the activity or plan in the words they used, shortened to a short
  label. Null when they did not name one.
- `pickupDate`: YYYY-MM-DD copied from `now.nextDays` when they named a day
  ("tomorrow", "Saturday", "明天", "周六", "demain"). Tomorrow is the day after
  `now.date`. A weekday is that weekday's date in `nextDays`. When they name
  both ("tomorrow Saturday", "明天周六"), both have to be that same date; if
  they are not the same day in `nextDays`, leave this null. Null when they
  named no day.
- `pickupTime`: HH:MM on a 24-hour clock, the wall time they said in `timeZone`
  (8am is 08:00, 上午八点 is 08:00). Do not convert it to UTC and do not attach
  an offset. Null when they gave no clock time.
- `pickupPlace`: the pickup place in their words. Null when they did not name one.
- `kids`: the children being driven, in their words. Null when they did not name
  them.
- `confidence`: `high` when the intent is clear enough to store. `low` when you
  would not want Hale to change who is driving from this.

Read meaning, not keywords. Any language. A tapback on Hale's driver ask from a
named person is a claim by that person. Two people volunteering is a swap to the
one this message is about, not a rota Hale invents.

Return the object.
