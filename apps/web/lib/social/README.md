# Hidden-social watchlist (VIL-378)

Hale watches professional accounts that post kids' activities across the GTA:
Toronto, Peel, York, Halton, and Durham, plus a day-trip fringe. The product
is a year planner. This module finds what is on. It does not text a parent,
and it does not write the words a parent would see. Design owns that copy.

`SOCIAL_WATCHLIST` defaults to off. The poll, the signup tick, the Linq
forward hook, and `POST /api/social/forward` run only when the value is
exactly `on`.

## What is polled

Instagram Business Discovery, official Graph only:

`GET /{IG_USER_ID}?fields=business_discovery.username({handle}){media.limit(20){id,caption,timestamp,permalink,media_type}}`

Stories are not in that response and are not requested. Xiaohongshu and
WeChat are not scraped. The Facebook Events API and the Meta Content Library
are not used. Facebook pages sit on the watchlist so the same places are
named; the poller skips `facebook_page` until a Page Public Content Access
review exists.

A source whose `last_media_id` is null establishes a watermark and extracts
nothing. Later polls take media newer than that id. At most 25 accounts run
per hourly cron (`/api/cron/social-watch`, minute 18).

## Meta app setup

1. Create a Meta app, type Business, and add the Instagram product with
   Facebook Login.
2. Connect a Hale-owned Instagram professional account (Business or Creator)
   to a Facebook Page. Personal accounts cannot call Business Discovery, and
   the target account must be professional too.
3. Request these permissions, then App Review plus business verification
   before any account other than a role on the app can be read:
   - `instagram_basic`
   - `instagram_manage_insights`
   - `pages_read_engagement`
   - `pages_show_list`
4. Put the long-lived user token and the Hale Instagram user id in the web
   project's environment. Do not commit either value.

| Env | Purpose |
| --- | --- |
| `META_GRAPH_ACCESS_TOKEN` | User token with the permissions above |
| `META_IG_USER_ID` | Hale's own Instagram professional user id |
| `SOCIAL_WATCHLIST` | `on` to poll and tick. Anything else, including unset, stays dark |
| `ANTHROPIC_API_KEY` | Optional. Absent means caption extraction stays on the deterministic placeholder and the run says `llm: not_configured` |

If either Meta variable is missing, the cron returns
`poll.skipped = meta_not_configured` and does not call Graph.

Graph version in code: `v21.0` (`META_GRAPH_VERSION`).

## Signup-open watches

Registration alerts are part of the same job as discovery. When an extracted
spot has both `registration_opens_at` and `registration_url`, the row is the
job: `watch_status = scheduled`, `next_wake_at` fifteen minutes before open.
The every-minute drain ticks due rows while the flag is on, so a read lands
inside the two minutes after open. The organizer's page is fetched. Sold-out
copy marks the watch `filled`. An unreadable page stays `armed` and wakes
again in sixty seconds. After the two-minute window the watch is `missed`.
No SMS is sent.

## Structured rails, beside this list

Municipal season catalogs, EarlyON locators, and library calendars already
have civic and registration paths in Hale. This watchlist does not rebuild
those portals. It is the hidden-social layer: professional accounts that
post a drop-in, a farm weekend, or a PA-day camp that never lands in
PerfectMind. A city Instagram account is here only because it announces a
registration window. The season catalog stays on the civic rail.

## Captions, not flyer vision yet

Extraction reads the caption. Ask Hale can already send an image to the
model (`lib/coach/attachment-blocks.ts`), and `forceToolJson` only accepts
text, so a flyer image is not read. `FLYER_VISION` is `caption_only`.
TODO: when a post image is cached locally, pass it through that image block
and drop any fact the caption and the image do not both support. Do not
store expiring CDN media URLs.

## Out of scope

A free "claim this listing" for organizers (the GoPlay-style supply
conversion) is phase 2. This PR does not add a claim flow, a provider
portal, or a partner pack.

## Parent forwards

A parent can hand in a link or a screenshot URL. Linq queues that only when
the flag is on, and the reply does not change. `POST /api/social/forward`
with `Authorization: Bearer $CRON_SECRET` and `{ "familyId", "url" }` is the
same queue without a phone. The URL is not fetched.

## Seed

`seed.ts` is the watchlist. Handles were read off an organization page, a
municipal homepage, or a Kids Pass directory card on 2026-09-27. The list
is balanced across Toronto, Peel, York, Halton, and Durham: at least 20
active accounts in each region, and most of the list sits outside Toronto.
Rows with `active: false` were named in that pass but the city was not on
the page, so they are not polled. Loading them into `watched_sources` is a
deliberate insert, not a migration.
