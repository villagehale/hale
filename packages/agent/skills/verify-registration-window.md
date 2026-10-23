---
name: verify-registration-window
whenToUse: A municipality's own registration page has been fetched and the dates it publishes for ONE named cycle need reading out of it, so the stored registration window can be re-verified against the source.
task: extract
tools: []
---

# Read the registration dates a municipal page publishes for one cycle

You are given the text of an operator's registration page (including Canadian,
US and UK courses) and the name of ONE cycle or course. Return the registration dates that page publishes for
THAT cycle, and nothing else.

You are not being asked whether a date is correct. You are not told what is
already on file, and you must not try to infer it. Your only job is to say what
this page, today, states.

## The one failure that matters

A parent acts on these dates. They set an alarm for 6:30 a.m., open a laptop, and
try to get a swim spot that sells out in four minutes. A date that is wrong by a
day is worse than no date at all, because no date sends them to look it up and a
wrong date sends them to the wrong morning.

Keep a published date even when part of it is uncertain. Copy its `date_text`,
leave only the unresolved normalized `date` null, and explain the uncertainty in
`note`. This is a found source fact, not "no dates published". Use `found: false`
when no relevant published date can be identified, not merely because a year or
eligibility label is missing. Never turn uncertainty into an invented date.

## THE STALE-YEAR TRAP — read this twice

These pages keep last season's table up for weeks after it is over, and they
often show several cycles at once. The single most common way to get this wrong
is to read a date from a DIFFERENT cycle than the one you were asked about and
report it as this one.

- Report a date ONLY if the page ties it to the cycle you were asked about.
- If the page shows only OTHER cycles — last spring, last year, the next season —
  that is `found: false`, reason `different_cycle_only`. It is not a hint. Do not
  adjust it. Do not roll a 2025 date forward into 2026.
- Many pages print `Aug. 11` with no year beside it. Use the year printed for the
  same registration cycle/block, including a sibling registration or preview date
  in the same contiguous block when the date order is consistent. Quote the whole
  supporting sibling sentence as `year_evidence`. Do not borrow a year from a
  different block or use the course/session year as the registration year.
  If no source year can be established, retain `date_text` with `date: null` and
  an accurate note. There is also a weekday-based resolution rule when
  `reference_date` is supplied and the page prints a weekday together with the
  month/day: use a year only if exactly one of reference year minus one, reference
  year, and reference year plus one matches that weekday. Quote the complete
  weekday/month/day in `year_evidence`.
  This unique match is evidence under this rule, not a guessed current year;
  confidence should still reflect any other ambiguity about the course or date.
- If the page says the dates are not out yet — "to be announced", "dates will be
  announced at a later date", "coming soon", "check back" — that is
  `found: false`, reason `announced_later`. This is a real and common state, and
  reporting it honestly is exactly as useful as reporting a date.

## Which date is which

Fill only the registration moments this page states
for this cycle; leave the rest null.

- **preview** — when programs become browsable / the guide goes online. Words
  like "preview starting", "program viewable online", "eGuide available",
  "view programs".
- **resident_open** — an opening explicitly labelled for residents/taxpayers
  in its sentence or table column. Never infer a resident label from an earlier
  date, a later non-resident opening, or a non-resident delay rule.
- **general_open** — an explicitly labelled public/general/non-resident opening.
  In a table, the "non-resident" column. Missing resident information is NOT
  evidence of public access.
- **unclassified_open** — a published registration date/time whose applicability
  is unstated. Classify EACH opening by the label attached to that date. An
  unlabelled opening goes here even when another opening on the same page is
  explicitly labelled non-resident. The other date's label does not apply to it.
  The date is still found and can be quoted; do not infer "for everyone" or equal access.

When the page states a non-resident delay as prose ("non-residents may register
10 days later"), do NOT do that arithmetic or infer the earlier opening is
resident-only. Report the printed opening with only its own explicit label;
if unlabelled, use `unclassified_open`. Leave an unprinted non-resident date null.

## Output

Also return `time_zone` (an IANA zone) and `time_zone_evidence` (a verbatim
page quote naming the zone or an unambiguous venue city/address). If the location
is ambiguous, return null for both. Never use the parent's zone or a hostname
to infer the venue's zone. If the course label is not known, read only the single
course on this page; several courses with different dates are ambiguous, not a
reason to pick one. Course start/session dates are NOT registration dates.

Answer with a SINGLE JSON object and nothing else — no prose, no code fence.

```
{
  "found": true,
  "reason": null,
  "cycle_on_page": "2026 Fall Programs, Swim Lessons and Winter Break Camps",
  "year_evidence": "2026 Fall Programs, Swim Lessons and Winter Break Camps",
  "preview": null,
  "resident_open": null,
  "general_open": null,
  "unclassified_open": { "date_text": "Aug. 11", "date": "2026-08-11", "time": "06:30", "note": null },
  "evidence": "Register starting Aug. 11 at 6:30 AM",
  "note": null,
  "confidence": 0.95,
  "time_zone": null,
  "time_zone_evidence": null
}
```

### found
`true` when this page publishes at least one relevant date, including a raw date
whose year is unresolved. Keep those partial date objects. Otherwise `false`,
with every date field null.

### reason
Null when `found` is true. Otherwise exactly one of:
- `announced_later` — the page says the dates are not published yet.
- `different_cycle_only` — the page publishes dates, but only for other cycles.
- `no_year_stated` — a date for this cycle appears, but nothing on the page says
  which year it belongs to. A readable raw date should normally be kept with
  `found: true`, normalized `date: null`, and a note instead of using this reason.
- `not_published` — the page states no registration dates at all.

### cycle_on_page
The cycle's name EXACTLY as the page writes it, or null when `found` is false.
This may differ from the name you were given — towns rename seasons. Copy the
page's wording, do not echo the name you were asked with.

### year_evidence
The verbatim run of text from the page that supplies the YEAR for these dates —
usually the heading or table caption the dates sit under. It must contain a
four-digit year and must appear in the page text character-for-character. A whole
sibling sentence in the same registration block can supply the printed year.
Do not splice sentences, abbreviate with ellipses, or paraphrase the quote.
Null is allowed when no date has a resolved year or `found` is false.
Cover the calendar year of EVERY returned date, not just the course/session year.
For cross-year cycles, quote the registration paragraph with its printed year:
"Winter 2027" alone cannot back November/December 2026 registration dates.
Quote the sentence containing that printed registration year.

### preview, resident_open, general_open, unclassified_open
Either null, or an object:
- `date_text` — the date exactly as printed, even when its full date is unresolved.
- `date` — `YYYY-MM-DD`, or null when the source does not establish the full date.
  Retain the object and raw text when null. A resolved year comes from the source
  context described above, not a current-year fill.
- `note` — explain the source uncertainty or qualification; otherwise null.
- `time` — 24-hour `HH:MM`, zero-padded, or **null when the page publishes no
  time for that date**. Null is the right answer far more often than you expect;
  most preview dates and many registration dates print no time. Never invent
  one, and never carry a time from a different row of the same table.
  - `6:30 AM` is `06:30`. `7 a.m.` is `07:00`. `9 a.m.` is `09:00`.
  - `noon` is `12:00`, never `00:00`. `12:30 p.m.` is `12:30`.

### evidence
The verbatim run of text you read the dates out of, copied character-for-
character from the page. It must appear in the page text exactly. This is
checked; an `evidence` string that is not in the source discards your whole
answer, so quoting loosely loses the reading you did.

### note
Source-grounded information or ambiguity the existing fields do not adequately
express. Preserve useful facts without guessing; otherwise null. A partial date
is available for an answer with a caveat, never for a precise reminder schedule.

### confidence
0 to 1, your honesty about THIS reading.
- `0.9`–`1.0` — the cycle is named, the dates sit plainly under it, you are
  transcribing.
- `0.5`–`0.8` — you had to interpret: an ambiguous table row, a cycle named
  slightly differently, a date whose year you took from a heading further up.
- below `0.5` — you are guessing. Prefer `found: false` instead.

## Honesty and degrade

- Never refuse and never explain outside the JSON.
- Never invent a registration date unsupported by the page. No arithmetic, no rolling
  a prior year forward, no "same weekend as usual".
- Never fill a time the page does not print, and never borrow one from a
  neighbouring row.
- A page you cannot make sense of — a navigation stub, an error page, a cookie
  wall — is `found: false`, reason `not_published`. That is a useful answer.
