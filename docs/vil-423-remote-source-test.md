# VIL-423: real remote DB source test

Run: 2026-10-11, 18:09 UTC. Uses `launch.env`'s remote Supabase connection; production versus staging identity was not independently established.

## Scope and safety

- Remote queries ran inside `BEGIN READ ONLY`, with `transaction_read_only = on` asserted. The DB connection closed before HTTP/model calls.
- Snapshot: `registration_windows` = 53; `registration_sequences` = 0; `watched_spots` = 0. There are no existing family registration watches in this configured DB to exercise.
- Selected five actual window records and their stored `source_url`. No new event discovery. DB dates were used only for comparison, not supplied to the extraction model.
- Tested the current local `createRegistrationReader`, actual safe page fetch, actual `extractPublishedWindow` model call, and evidence/eligibility gates. No mocked page or extraction result.
- No DB writes, migrations, production cron, SMS, deployment, or model configuration changes.

## Results

All five URLs fetched; five real AI extraction calls; two verified readings. Times below are `America/Toronto`. DB midnight timestamps are stored values, not proof that the source published midnight.

| Source / cycle | DB before | Live extraction / final outcome |
| --- | --- | --- |
| [Burlington](https://www.burlington.ca/en/recreation/registering-for-a-program.aspx), Fall 2026 swimming lessons | Residents Aug 22, 09:00; general Aug 28, 09:00 | **Verified**: same dates/times; preview Aug 12, time unknown. |
| [Richmond Hill](https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx), Winter 2026–2027 | Residents Nov 24, 00:00; general Dec 1, 00:00 | **Verified dates only**: Nov 24 / Dec 1; source did not publish a time (`time: null`). |
| [King](https://www.king.ca/recreation), Winter 2027 | General Dec 7, 00:00 | AI extracted Nov 23 preview, Dec 7 resident, Dec 11 nonresident, all in 2026 with unknown times. **Unverified: `uncorroborated`**. Its `yearEvidence` quote contains only 2027, which cannot corroborate the extracted 2026 dates. No dates accepted. |
| [Markham](https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information), 2026 Fall Programs, Swim Lessons and Winter Break Camps | Residents Aug 11, 06:30; general Aug 12, 06:30 | AI extracted Aug 11, 06:30 as general opening. **Unverified: `eligibility_unverified`**. Page quote does not establish resident versus nonresident eligibility, so this is not a confirmed public-date change. |
| [Uxbridge PDF](https://www.uxbridge.ca/public/download/files/360410), Winter 2027 | General Nov 10, 09:00 | Download succeeded and body starts `%PDF`. AI returned `found: false`; **unverified: `not_published`**. Current HTTP reader decodes bytes as UTF-8 and then strips HTML; it does not decode PDF text. This result does **not** prove the PDF lacks the date. |

Record IDs, the remote snapshot, full model extraction, final gated readings and elapsed times are in the [raw log](../.local/vil423-pre-post/remote-source-check.log).

## What this establishes

The live reader works for two selected HTML sources, including preserving unknown time instead of presenting DB midnight as published time. The sample also exposes a cross-year evidence failure, an eligibility ambiguity, and a PDF extraction gap. These five selected sources are not a representative success-rate benchmark. An unverified read must not fall back to old DB dates for parent-facing facts.

This is source-reader integration testing, not remote Coach/cron end-to-end testing. Remote watch tables are empty; no synthetic watch was inserted. Product code was not changed in this test.

## Rerun

From `/Users/yuhangsong/hale`:

```sh
node --env-file=launch.env .local/vil423-pre-post/remote-source-check.mjs
```

The [diagnostic script](../.local/vil423-pre-post/remote-source-check.mjs) asserts a read-only DB transaction. Rerunning performs new website requests and paid model calls; page contents/model outputs can change. It never runs reminder delivery.
