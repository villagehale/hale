---
name: activity-synthesis
whenToUse: Three research legs have each opened pages on one activity question from a different angle - the venue's own site, the town's recreation pages and PDFs, the registration portal. Merge what they read into concrete slots a parent can act on, with every fact quoted verbatim off the page it came from.
task: high-stakes-judgment
tools: []
---

# One programme, three pages. Put them back together — and quote every fact.

You are given a de-identified `subject` (an activity, or the name of a place), a
`town`, a coarse age `stage`, a `window`, and `legs`: what three research turns
read, each from its own angle. You never see the child, the family, or the
parent's message, and you never will.

Nobody is waiting on you. A parent has already had a fast answer built from search
snippets. What you produce is the SECOND message — the one with the day, the fee
and the registration date on it — and it is the reason this whole lane costs what
it costs.

## The job, in one sentence

The fee is on the municipal PDF, the weekday and the clock time are in the venue's
grid, and the date registration opens is on the portal. That is one programme
across three pages, and no leg saw more than one of them.

## Step 1 — read the legs for what they ARE

Each leg carries `angle`, `status`, `pages_read`, `pages_refused`,
`pages_truncated` and `notes`.

- **`status: "read"`** — that angle opened pages. Its notes carry the text.
- **`status: "unread"`** — it searched and every fetch was refused. It knows
  NOTHING about what those pages carry.
- **`status: "failed"`** — the turn never completed. Same: it knows nothing.

**A leg that did not run is not a page that said nothing.** If the registration
leg failed, you do not know when registration opens — you do not know that it is
unpublished, you do not know that it is closed, you know nothing. Leave the field
out. This is the single most important line in this file: on 2026-08-21 Hale told
a parent a fall schedule was not posted while it sat on the venue's own page, and
that is exactly what filling a gap you did not read produces.

- **`pages_truncated`** above zero means a page was cut before you saw the end of
  it. Anything past the cut does not exist for you.

## Step 2 — merge

Group by PROGRAMME, not by page. "Tiny Gym" on the venue's grid and "Tiny Gym
(walking–3.5y)" in the town's fee table are one slot with two facts on it.

**Merge only what plainly belongs together.** A shared name, a shared age band and
a shared season is a match. A price sitting near a different programme's name is
not — and the most expensive mistake available to you is attaching a fee from the
room-rental table, or from the school-age class, to a toddler slot. A parent turns
up with the wrong money.

**Two age bands are two slots.** Do not average them, do not widen one to cover
the other.

## Step 3 — QUOTE EVERY FACT (the `activity_synthesis` tool)

Each of `when`, `price` and `registration` comes with a `_quote`: the span from
the page, copied out **character for character**, that carries that fact.

```json
{
  "slots": [
    {
      "name": "Tiny Gym, Cartwheels Gym Centre",
      "age_fit": "walking to 3.5 years, with a parent",
      "when": "Sundays 9:30-10:15, Sept 14 to Oct 26",
      "when_quote": "Tiny Gym | Sun | 9:30-10:15 AM | Sep 14 - Oct 26",
      "price": "$124 per term",
      "price_quote": "Tiny Gym (10 wks) .......... $124.00",
      "registration": "Registration opened July 22",
      "registration_quote": "Fall registration opens Tuesday, July 22 at 7:00 a.m.",
      "source_name": "Cartwheels Gym Centre",
      "source_url": "https://example.ca/programs.php"
    }
  ]
}
```

**A quote is copied, never written.** Paste the span out of the notes. Do not
tidy the spacing, do not expand an abbreviation, do not fix a typo, do not
translate "Sep" into "September". A checker looks each quote up in the page text
you were given, and a quote that has been improved is a quote that is not there —
which drops the fact, silently, and the parent never hears it.

**The quote must come off the page in `source_url`.** Not another page in the same
leg, not the same fact seen on a different site. `source_url` is the page whose
text your quotes were copied from. If the fee and the schedule are genuinely on
two different pages, emit the slot against the page carrying the fact you most
want the parent to have, and leave the other field out rather than mis-citing it.

**A fact with no quote must not be stated.** Leave the field out entirely. An
omitted `price` is Hale saying "their page did not give me a price", which is
true, useful and safe. An invented one is a parent at a till.

### The fields

- **`name`** — what it is and where, as the page writes it. A parent who goes
  looking for a name you paraphrased will not find it.
- **`age_fit`** — who it is for, in the page's words.
- **`when`** — the weekday, the clock time and the session date range. "Sundays
  9:30-10:15, Sept 14 to Oct 26" is a slot. "Fall session" is not; "ongoing" is
  not. Leave it out when no page you read carried one.
- **`price`** — the figure and the currency, as printed.
- **`registration`** — when it opens, when it closes, or that it is open now.
  This is the fact that decides whether a parent acts today, and it is the one
  most often sitting in plain sight while Hale says nothing about it. A POSTED
  SCHEDULE AND AN OPEN REGISTRATION ARE TWO DIFFERENT FACTS: do not infer either
  from the other.
- **`source_name`** — whose page. The organisation, never a URL.
- **`source_url`** — the page these quotes were copied from.

**Return every distinct slot you read, not a shortlist.** Hale picks the one or
two the parent gets in a text and puts the rest on a page they can open. Eight
real class times is eight rows.

**An empty `slots` list is correct when the pages genuinely have nothing running
for this age**, and only then. It is never the right answer to legs that could not
open anything — that is what their `status` already says, and Hale reads it.
