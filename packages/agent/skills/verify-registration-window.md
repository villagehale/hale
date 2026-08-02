---
name: verify-registration-window
whenToUse: A municipality's own registration page has been fetched and the dates it publishes for ONE named cycle need reading out of it, so the stored registration window can be re-verified against the source.
task: extract
tools: []
---

# Read the registration dates a municipal page publishes for one cycle

You are given the text of a Canadian municipality's recreation registration page
and the name of ONE cycle. Return the registration dates that page publishes for
THAT cycle, and nothing else.

You are not being asked whether a date is correct. You are not told what is
already on file, and you must not try to infer it. Your only job is to say what
this page, today, states.

## The one failure that matters

A parent acts on these dates. They set an alarm for 6:30 a.m., open a laptop, and
try to get a swim spot that sells out in four minutes. A date that is wrong by a
day is worse than no date at all, because no date sends them to look it up and a
wrong date sends them to the wrong morning.

So: **when you are not sure, say you did not find it.** `found: false` is a
complete, correct, valuable answer. It costs a human two minutes of checking. A
confident wrong date costs a family the season.

## THE STALE-YEAR TRAP — read this twice

These pages keep last season's table up for weeks after it is over, and they
often show several cycles at once. The single most common way to get this wrong
is to read a date from a DIFFERENT cycle than the one you were asked about and
report it as this one.

- Report a date ONLY if the page ties it to the cycle you were asked about.
- If the page shows only OTHER cycles — last spring, last year, the next season —
  that is `found: false`, reason `different_cycle_only`. It is not a hint. Do not
  adjust it. Do not roll a 2025 date forward into 2026.
- Many pages print `Aug. 11` with no year at all. You may only supply a year that
  the page itself states for that cycle — in the section heading, the table
  caption, the cycle's own name. If nothing on the page supplies the year for
  this cycle, that is `found: false`, reason `no_year_stated`.
- If the page says the dates are not out yet — "to be announced", "dates will be
  announced at a later date", "coming soon", "check back" — that is
  `found: false`, reason `announced_later`. This is a real and common state, and
  reporting it honestly is exactly as useful as reporting a date.

## Which date is which

Municipalities publish up to three moments. Fill only the ones this page states
for this cycle; leave the rest null.

- **preview** — when programs become browsable / the guide goes online. Words
  like "preview starting", "program viewable online", "eGuide available",
  "view programs".
- **resident_open** — when residents/taxpayers may register, where the town runs
  a head start. In a table this is the column headed "resident".
- **general_open** — when anyone may register. In a table, the "non-resident"
  column. On a page with no resident/non-resident split at all, the single
  published registration moment is `general_open` and `resident_open` is null.

Some towns print only the resident date and state the non-resident rule as prose
("non-residents may register 10 days later"). Do NOT do that arithmetic. Report
the printed resident date and leave `general_open` null.

## Output

Answer with a SINGLE JSON object and nothing else — no prose, no code fence.

```
{
  "found": true,
  "reason": null,
  "cycle_on_page": "2026 Fall Programs, Swim Lessons and Winter Break Camps",
  "year_evidence": "2026 Fall Programs, Swim Lessons and Winter Break Camps",
  "preview":       { "date": "2026-08-03", "time": null },
  "resident_open": null,
  "general_open":  { "date": "2026-08-11", "time": "06:30" },
  "evidence": "Register starting Aug. 11 at 6:30 AM",
  "confidence": 0.95
}
```

### found
`true` only when this page publishes at least one date for the cycle you were
asked about. Otherwise `false`, with every date field null.

### reason
Null when `found` is true. Otherwise exactly one of:
- `announced_later` — the page says the dates are not published yet.
- `different_cycle_only` — the page publishes dates, but only for other cycles.
- `no_year_stated` — a date for this cycle appears, but nothing on the page says
  which year it belongs to.
- `not_published` — the page states no registration dates at all.

### cycle_on_page
The cycle's name EXACTLY as the page writes it, or null when `found` is false.
This may differ from the name you were given — towns rename seasons. Copy the
page's wording, do not echo the name you were asked with.

### year_evidence
The verbatim run of text from the page that supplies the YEAR for these dates —
usually the heading or table caption the dates sit under. It must contain a
four-digit year and must appear in the page text character-for-character. Null
only when `found` is false.

### preview, resident_open, general_open
Either null, or an object:
- `date` — `YYYY-MM-DD`. The year comes from `year_evidence`, never from
  anywhere else.
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

### confidence
0 to 1, your honesty about THIS reading.
- `0.9`–`1.0` — the cycle is named, the dates sit plainly under it, you are
  transcribing.
- `0.5`–`0.8` — you had to interpret: an ambiguous table row, a cycle named
  slightly differently, a date whose year you took from a heading further up.
- below `0.5` — you are guessing. Prefer `found: false` instead.

## Honesty and degrade

- Never refuse and never explain outside the JSON.
- Never output a date that is not written on the page. No arithmetic, no rolling
  a prior year forward, no "same weekend as usual".
- Never fill a time the page does not print, and never borrow one from a
  neighbouring row.
- A page you cannot make sense of — a navigation stub, an error page, a cookie
  wall — is `found: false`, reason `not_published`. That is a useful answer.
