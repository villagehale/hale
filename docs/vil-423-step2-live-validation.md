# VIL-423 step 2 — real English conversation verification

2026-10-15. Branch `codex/vil-423-live-truth`, product code `03b5d1e53`.

## Verdict

The observed context/link regressions pass: **all five searches across three real conversations retain London, Ontario, Canada, London Public Library and October 2026**, including retries across `search_village` and `find_activities`. Both conversations returning dated sessions retain the exact filtered official URL in the final SMS body. The generic-page conversation retains its base source URL but does not exercise query preservation. No freshly returned source has a fragment; fragment restoration remains fixture-tested, not newly live-tested here.

**Complete activity retrieval is only 2/3 successful.** The first ordinary run reads the unfiltered listing and Eventbrite organizer page, produces one unscheduled generic pick and then no picks on retry. It never reaches the Storytime-filtered page that supplies sessions in the other two runs. Its `Ages 2-5` comes from a general audience-filter option, not evidence of a particular program's age range. This is not accepted as a successful schedule answer. The original failed outcome is retained, not replaced with a successful rerun.

| Conversation | Context on every search | Final source link | Requested schedule | Runtime elapsed |
| --- | --- | --- | --- | --- |
| Ordinary question, run 1 | Pass, 2/2 searches | Base URL preserved; no filtered source found | Fail: no individual sessions | 70.8s |
| Explicit price question | Pass, 1/1 search | Exact filtered URL preserved | Three published sessions match captured page | 55.5s |
| Ordinary question, run 2 | Pass, 2/2 searches | Exact filtered URL preserved | Three published sessions match captured page after retry | 62.4s |

These timings cover the local Coach runtime, not carrier first-reply latency or a p50/p95 acceptance measurement. Three samples are not a reliability guarantee.

## Inputs and actual final replies

Ordinary question (two independent runs):

> What storytimes does London Public Library in Ontario have for my preschooler in October 2026? Check the current official website and tell me the published dates, times and prices, with the official links.

Run 1, actual final reply:

> London Public Library's What's On page has a Storytimes listing with an ages 2-5 filter, which fits Maya. The page I read didn't show any individual October 2026 sessions, so I have no dates, times or prices to give you. A missing price means it wasn't published, not that it's free. The official page is https://www.lpl.ca/whats-on. I'll look again tomorrow and text you any October sessions with their dates, times and prices.

The future follow-up is only a returned intent in this diagnostic; no message was sent and no downstream follow-up sweep was tested.

Run 2, actual final reply:

> London Public Library's site lists three storytimes for ages 1+ that fit Maya, all indoor drop-ins: Storytime (Ages 1+), Beacock Library: October 16, 2026, 10:30 am - 11:30 am Storytime (Ages 1+), Sherwood Library: October 17, 2026, 10:00 am - 11:00 am Storytime (Ages 1+), Children's Library: October 19, 2026, 10:30 am - 11:30 am The page doesn't publish a price for any of them, so I can't say what they cost. These come from their own listing, and I haven't confirmed them separately. The official listing link is below. Want me to add one of these to Maya's calendar? https://www.lpl.ca/whats-on?field_start_date_value_1=&field_start_date_value_2=&custom_date_range=All&field_topic_target_id=42&field_audience_target_id=All&field_venue_target_id=All&combine=

Explicit price question:

> Are the London Public Library Storytime programs free for preschoolers in October 2026? Please look at the current official pages now. If the pages do not publish a price, say that instead of assuming free. Include the source links and any published schedule.

Actual final reply:

> The London Public Library pages I read list these Storytimes for ages 1+, and none of the listings I read publish a price. I can't tell you they're free, so I won't assume it. Here's the published schedule: Storytime (Ages 1+), Beacock Library: Oct 16, 2026, 10:30 am - 11:30 am Storytime (Ages 1+), Sherwood Library: Oct 17, 2026, 10:00 am - 11:00 am Storytime (Ages 1+), Children's Library: Oct 19, 2026, 10:30 am - 11:30 am Maya is 4, so she fits the 1+ age range. The source is the London Public Library's own What's On listing. https://www.lpl.ca/whats-on?field_start_date_value_1=&field_start_date_value_2=&custom_date_range=All&field_topic_target_id=42&field_audience_target_id=All&field_venue_target_id=All&combine=

The two successful runs' three branch/date/time/age tuples occur together in their freshly read, cited Storytime-filtered page. All returned prices remain null; final replies do not assert Free. This validates these particular tuples, not every activity or all pages of the calendar.

## Method and reproduction

Actual production `channelCoachRuntime`, guarded tools, family readers, Finder search, pinned HTTP reads, structured extraction and SMS post-processing. Synthetic local PGlite family in London ON, Canada; four-year-old child, English, empty transcript. No model/page replay. Only observation wrappers and an allowlist refusing unrelated effectful tools. The existing local harness was updated to recognize main's JSON-schema extraction and pass `offered.recordLinks` to the injected real activity tool, matching production wiring; no product logic was changed for this run.

**19 completed model requests**, all `claude-sonnet-5-5`; 11 provider web searches. Usage: 409,103 input, 12,956 output, 71,382 cache-creation input and 139,680 cache-read input tokens, reported separately as supplied by the provider. These are usage counts, not a billing invoice.

Run a new paid sample from the repo root (fresh model/search/page requests; result can vary):

```sh
node --env-file=launch.env .local/vil423-pre-post/fresh-finder-coach-2026-10-15.mjs london-storytime
```

Review the three saved runs without API calls:

```sh
node .local/vil423-pre-post/step2-live-review.mjs
```

Artifacts (local, ignored): [review assertions](../.local/vil423-pre-post/step2-live-review.mjs), [reviewed queries and full replies](../.local/vil423-pre-post/step2-live-review.json), [ordinary run 1](../.local/vil423-pre-post/step2-live-london-ordinary-1.log), [price question](../.local/vil423-pre-post/step2-live-london-price.log), [ordinary run 2](../.local/vil423-pre-post/step2-live-london-ordinary-2.log). Logs retain raw model answers, tool inputs/results, usage and fresh extraction page text.

Not tested: inbound routing, real carrier send, remote DB, reminder cron, follow-up delivery, broad multi-city reliability or deployment. No product-code changes, push, Linear/Slack update or production action in this verification.
