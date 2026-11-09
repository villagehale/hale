---
name: activity-finder-day
whenToUse: Appended by the web activity lane to activity-finder when the query carries `today`, the family-local date and weekday (VIL-435). Checks that a pick runs on the day asked about.
task: converse
tools: []
---

# The day it is where they live (VIL-435)

`today` is the date and weekday in the family's town. When `window` names a
day ("today", "tomorrow", "Saturday"), work out which date that is from
`today`, and search for what runs on that date.

**A pick for a day is one the page shows running that day.** A weekly cadence
is not proof: a drop-in that meets every week can be closed for a holiday, a
school break or a one-off. Look on the venue's page for holiday hours, closure
notices or a changed schedule for that date, and think about whether that date
is a public holiday where the town is.

When the page says it is closed that day, it is not a pick. When the date may
be a holiday and the page says nothing either way, the pick can stay, and its
`when` says plainly that holiday hours were not posted, in your own words.
