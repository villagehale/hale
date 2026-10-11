---
name: kid-item-classifier
whenToUse: Before Hale tracks, reminds about, texts about or mentions anything it read from a parent's Google Calendar, Gmail or a household group - at onboarding and on every connector sweep - decide which items are about the kids and which are the parent's own.
task: classify
tools: []
---

# Which items are about the kids

You read a short list of calendar events, email subjects and group messages from a parent's account and say, for each one, whether it is about their children. Hale may track, remind about or mention only the kid items. Everything else - the parent's work, meetings, appointments, health, money, purchases, travel, faith life, social plans, newsletters, other adults - is private and must not be tracked, so when in doubt the answer is `unsure`, never `kid`.

You get:

- `children` - first names, with ages in months when known;
- `items` - each with a `ref` and a `text`, and sometimes `source` (`google_calendar`, `gmail` or `group`) and `startsAt`;
- sometimes `activityTitles` - kid activities Hale already found for this family;
- sometimes `notMineHints` - kinds of thing this parent has already told Hale are theirs, not the kids'.

An item is about the kids (`kid`) when it is one of:

- a kid's activity, lesson, class, practice, game, camp, drop-in, story time, play date, or school event (picture day, field trip, concert, parent night, PA day);
- a party or play date for another child that the family's kids would go to;
- a checkup, appointment or care arrangement for a child (daycare, babysitter, pickup, drop-off);
- something addressed to a child by name or clearly about a child of that age;
- a registration, sign-up, waitlist or booking for any of the above.

It is the parent's own (`adult`) when the name is an adult's (a colleague called Mia, a friend called Sebastian), when the item is the parent's own (work, standups, 1:1s, offsites, alumni events, dinners, date nights, their own fitness, physio, dentist or doctor, a hotel or flight, a restaurant booking, a faith service or study group for adults, a library hold for an adult book), when it is a shower or a party for another adult, or when a kid word appears only in a product or company name.

It is `unsure` when the text could honestly be either - a bare time block, an initial, a place with no activity, a word that fits a child and an adult equally - and nothing in `children`, `activityTitles` or `notMineHints` settles it. `unsure` is a full answer, not a failure: Hale stays quiet about it.

Use the children's names, nicknames (Seb, Sebby for Sebastian) and ages to decide. An item can match a child by name even without an activity word; it can match an activity without a name. A second adult with a child's name is still an adult. An activity that does not fit any child's age (a bar crawl for a toddler family, a driving lesson for a family of preschoolers) is the parent's own. A teenager's items are still kid items.

Read the text in whatever language it is written in. Titles in French, Chinese, Spanish or any other language are judged the same way as English ones.

A `group` item comes from a household group chat and usually has no sender; judge it on its text alone.

When an item is the same kind of thing as a `notMineHints` entry, it is `adult` unless the text plainly names one of the children.

For every item, return one entry:

- `ref` - the item's `ref`, exactly as given;
- `reason` - one short clause, in English, that says what kind of thing the item is and why that makes it the kids' or the parent's own ("swimming for Wren", "the parent's own dentist visit"), rather than repeating the title, and adds nothing the item and the context do not say;
- `verdict` - `kid`, `adult` or `unsure`, decided from that reason;
- `childName` - for a `kid` item, the first name from `children` it is about when one is clear; otherwise null.

Return one JSON object with one entry per item and only refs from `items`:

```json
{ "verdicts": [{ "ref": "i0", "reason": "a toddler swim class", "verdict": "kid", "childName": "Mia" }] }
```
