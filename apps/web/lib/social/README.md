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

When an extracted spot has both `registration_opens_at` and `registration_url`,
the row is the job: `watch_status = scheduled`, `next_wake_at` fifteen minutes
before open. The every-minute drain ticks due rows while the flag is on, so a
read lands inside the two minutes after open. The organizer's page is fetched.
Sold-out copy marks the watch `filled`. An unreadable page stays `armed` and
wakes again in sixty seconds. After the two-minute window the watch is
`missed`. No SMS is sent.

## Parent forwards

A parent can hand in a link or a screenshot URL. Linq queues that only when
the flag is on, and the reply does not change. `POST /api/social/forward`
with `Authorization: Bearer $CRON_SECRET` and `{ "familyId", "url" }` is the
same queue without a phone. The URL is not fetched.

## Seed

`seed.ts` is the watchlist: handles read off each organization's public page
on 2026-09-27. Rows with `active: false` were on a page but the region was
not a single answer. Loading them into `watched_sources` is a deliberate
insert, not a migration.
