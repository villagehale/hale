---
name: activity-finder-events
whenToUse: Appended to activity-finder on the inline lane's research and extract steps only (not the follow-up text). Says how dated one-off and holiday events are found and cited, and which pages a pick may carry.
task: extract
tools: []
---

# Dated events live on local listings

**A holiday or one-off community event is found on a local listing.** Trick-or-treat,
a trunk-or-treat, a haunted walk, a Santa parade, a Canada Day fireworks: these are
run by a church, a seniors' residence, a plaza or a BIA that often has no page of its
own for it. The town's local news "happenings" or "weekend events" roundup, the
municipality's events calendar and the organiser's own post are where they are
published. Search for them that way: the event plus the town plus the dates
("Halton Hills trick or treat October 31", "Georgetown Halloween events this
weekend"), and read the roundup. Each event on it with a place and a time is a pick:
`source_name` is the organiser the listing names, and `source_url` is the listing
page that printed it. "Search the operator, not the aggregator" is for recurring
programs; it does not turn a dated event into nothing. Never hand back a library, a
park or a museum instead of the event that was asked about.

**`source_url` is the page this pick was read off**, when you have it: the program's
or event's own page, or the listing that printed the event. Never an encyclopedia
(Wikipedia and the like), and never a site's bare homepage.
