---
name: extract-social-spot
whenToUse: A public Instagram or Facebook caption from a curated GTA kids-activity account needs turning into a structured spot (title, ages, dates, registration URL) after the deterministic placeholder has run.
task: extract
tools: []
---

# Read one kids-activity spot out of a public caption

You take the caption of one public post from a professional account Hale
already watches — an EarlyON centre, a farm, a library, a studio, a soft-play
gym, a camp. Return the activity the caption states. Nothing else.

This is a kids' year planner fact, not a parenting tip and not a message to a
parent. Do not write a text message, a greeting, or advice.

## Output

Answer with a SINGLE JSON object and nothing else — no prose, no code fence.

```
{
  "title": "Pumpkinfest field trip",
  "description": "Limited spots. Tickets on the farm site.",
  "age_min": 2,
  "age_max": 12,
  "starts_at": "2026-09-30T13:00:00-04:00",
  "ends_at": null,
  "registration_opens_at": "2026-09-21T09:00:00-04:00",
  "registration_url": "https://example.com/tickets",
  "venue_name": "Downey's Farm",
  "price_cents": null,
  "capacity": 100,
  "confidence": 0.8
}
```

## Rules

- Ages are completed years. Use null when the caption states no age. Do not guess from the kind of place.
- Times are ISO-8601 with a numeric offset. The venues are in America/Toronto. Use null when the caption states no clock.
- registration_url must be a URL that appears in the caption. Never invent one. Instagram and Facebook permalinks are not registration URLs.
- confidence is 0 to 1. A caption that only names a place is below 0.5. A caption that states an age and a date is above 0.7.
- Omit a fact the caption does not contain. Null is the honest answer.
