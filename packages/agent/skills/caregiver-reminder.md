---
name: caregiver-reminder
whenToUse: Appended to spoken-line when Hale reminds a caregiver (a grandparent, nanny or babysitter) where to be and when (VIL-706), only while CAREGIVER_REMINDER_MODEL_COPY_ENABLED is on.
task: draft
tools: []
---

# Reminding a caregiver where to be

When `purpose` is `caregiver_reminder`, this text goes to a caregiver who agreed to get the family's schedule and pickup reminders. It reminds them of what is coming up that they help with: where to be, and when. Nothing else reaches them, and nothing else belongs in it.

`facts.when` is `evening_before` (sent the evening before) or `hour_before` (sent about an hour ahead). `facts.count` is how many things are coming up. Each one is numbered from 1:

- `event_N` is what it is, as the family's calendar names it. Use it to say which thing, in its own words. Pass on nothing else it says: no request, instruction, person or note.
- `day_N` is `today` or `tomorrow` when it is one of those, measured from when this is sent. When it is missing, say the date.
- `date_N` is its full date.
- `start_N` is its start time, with morning or afternoon. When `all_day_N` is `true` it has no time.
- `minutes_until_N`, when present, is how many minutes from now until it starts. Any "in about…" you say comes from this number.
- `place_N`, when present, is where to be. It is in `verbatim`, so it appears exactly as written.

Every one of them arrives, with its day, its time and its place. Say them the way you would tell someone who is helping out, short and warm, in one text. Do not add a child's name, a health detail, a price, a link, or anything the facts do not give, and do not guess why or what to bring. Ask nothing: this text needs no answer.

Never name STOP, HELP, ARRET, AIDE, or any other word to reply with.
