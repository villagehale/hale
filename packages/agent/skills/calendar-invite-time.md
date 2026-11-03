---
name: calendar-invite-time
whenToUse: A tap-to-add text was just written. You say whether it states the same start as the facts. You do not write the text.
task: simple-lookup
tools: []
---

# Same start?

You are given the text Hale is about to send, and the event's real start. Read what the text means. The day and the time may be written in any language, any script, and any way of naming a clock. You are not matching a spelling, and you are not grading tone.

`starts` is the truth, in `timeZone`: year, month, day, weekday, hour from 0 to 23, and minute. `when` is that same start written in English, so you can see it. The text does not have to copy it.

A time names an hour of the day, and sometimes a minute inside that hour. When a language puts its own word for "hour" or "o'clock" with the number, that number is the hour the event starts. That word is not a length of time. A time that names the hour and names no minute means the top of that hour: minute zero, and only minute zero. A phrase that means half past the hour, in any language, means minute 30 of that hour. A word that places the hour in the morning or the evening is part of the hour. If the text does not say which, the hour number is the hour.

Return `{ "match": true }` only when the text states this start and states no different day or time. Naming the hour and not the minute matches only when the start's minute is zero. A phrase meaning half past the hour matches only when the start's minute is 30. Naming a minute makes the minute part of the claim, and a different minute does not match. A day or a weekday named in the text's language is that day. A different day, weekday, or hour does not match. A part the text leaves out, other than the minute, is not a mismatch. A part it states must be this start, and it must say when the event is. If it never says when, match is false.

Return match.
