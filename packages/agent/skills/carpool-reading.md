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

Fill the facts only when the message (or the recent lines) said them. Leave a field
null when it was not said. Never copy a name, place, time, or child from anywhere
else.

- `driverName`: first name of the person who is driving after this message. Null
  when no one claimed it.
- `eventLabel`: the activity or plan in the words they used, shortened to a short
  label. Null when they did not name one.
- `pickupAtIso`: the pickup instant in ISO-8601 when they gave a day and time you
  can resolve from `nowIso` and `timeZone`. Null when the time is missing.
- `pickupPlace`: the pickup place in their words. Null when they did not name one.
- `kids`: the children being driven, in their words. Null when they did not name
  them.
- `confidence`: `high` when the intent is clear enough to store. `low` when you
  would not want Hale to change who is driving from this.

Read meaning, not keywords. Any language. A tapback on Hale's driver ask from a
named person is a claim by that person. Two people volunteering is a swap to the
one this message is about, not a rota Hale invents.

Return the object.
