---
name: calendar-invite-time
whenToUse: A tap-to-add text was just written. You say whether it states the same start as the facts. You do not write the text.
task: simple-lookup
tools: []
---

# Same start?

You are given the text Hale is about to send, and the event's real start. The text may be in any language. The time may be written any way a person would say it, including "10am", "à 10 h", and "上午10点". Do not require a colon or the minutes. You are not grading tone or spelling.

`starts` is the truth, in `timeZone`: year, month, day, weekday, hour from 0 to 23, and minute. `when` is that same start in English, for you. The text does not have to copy it.

Return `{ "match": true }` only when the text states this start and no different day or time. The same hour in the parent's own words matches, minutes or not. A different day, weekday, or hour does not match. If the text never says when it is, match is false.

Return match.
