# VIL-423 — approved recording run results

Source: `36392678a`; [Barton’s ONE-pass approval](https://linear.app/villagehale/issue/VIL-423#comment-38315769).
Frozen prompts, models, business code and thresholds were not changed.
The recording pass is finished. **No further paid calls without a new approval.**

**Not merge-ready.** Missing recordings were filled, but real quality failures remain.
[Verbatim outputs, parsed openings, failures and final ledger](https://linear.app/villagehale/issue/VIL-423#comment-3fdb1c51)
were posted **before** any recording commit. Tests/grades have not been weakened.

## Results

| Gate | Actual result |
| --- | --- |
| Registration extraction | **11/12 exact**; King misses the printed Dec 7 opening. All 12 replay without a missing key. |
| Reminder/link delivery | **11/13 accepted on inspection**; one English draft held, one French draft garbled. Twelve actual judge calls score at least 4; English hold has a harness sentinel of 1, not a judge call. |
| Changed chat rules | Pending heads-up, check-in, EN/FR/Arabic links all score 5: confirm in this chat, no reply menu. |
| Legacy Finder | **3/8 automated pass, 5/8 fail**; cached-only replay makes zero live calls and preserves the failures. Not a blanket factual-accuracy claim. |
| Fresh Burlington | Full real Coach path exercised; geography, future dates and unknown price survive, but age/source-instance ownership is **not accepted**. |
| Full Web cached replay | **10,549 pass / 14 skip / 1 fail**. No localized missing-key failures; English held-message positive test still fails. |
| Root build / repo scripts | **7/7 build tasks**, **64/64 script tests** pass. Root lint passes with existing warnings; **76/76** prompt hashes match. |

Registration inputs are fixed page text (including controlled new contract cases);
reminder/link inputs are saved official HTML with historical clocks. Those model
calls are real, but they are not fresh website fetches or carrier sends.
Burlington alone is the additional fresh, complete Coach → Finder → official-page
read → Coach/SMS-shaped response case. It uses a synthetic local PGlite family.

## Concrete failures, not new feature requests

### King: one published opening omitted

The page prints registration opening Dec 7, plus a separate non-resident aquatics
opening Dec 11, 2026. The result retains Dec 11 but returns
`unclassified_open: null`, dropping Dec 7. It does not mislabel Dec 7 as resident-only.
The unchanged exact-source test fails. No prompt patch or reroll was made.

### English waitlist: writer/guard contract mismatch

Actual draft: “You told us you're in position 2, and that your response deadline
is today, August 12, 2026, at 7:00 AM Toronto time.” The deadline is correct and
attributed to the parent. The draft does not repeat the registration opening.
The independent parser correctly returns `openings: []`, and the generic required-
opening check holds the reply. This is not a missing recording or an invented date.
The failed positive test remains; it was not converted to an expected hold.

### French: garbled before SDK parsing, not accepted despite score 4

The new waitlist reply contains `dĂ©but` / `aoĂ»t`. Captured response bytes decode
as valid UTF-8 **already containing those characters**, and SDK content matches.
The date guard returns a body; the judge calls the garbling a minor transport
artifact and scores 4. Human inspection rejects it. Valid UTF-8, a matching quote,
or a model score of 4 is not proof of valid French.

The initial diagnostic only searched the old Ć-pattern and missed this new pattern;
that diagnostic conclusion was corrected before commit, without changing any text
or making another model call. The two other new French replies are readable.
The old run’s missing HTTP bytes still prevent retrospective attribution.
[Raw payloads and byte-level audit](vil-423-french-wire-2026-10-19.json) retain all
three new French bodies. No production decoder patch or character replacement.

### Finder: automatic pass is not complete acceptance

| Case | Result / issue |
| --- | --- |
| toddler-fall-programs-halton-hills | Automated pass. |
| preschool-swim-oakville | Automated pass, but includes Mini ages 4–35 months under a preschool query; age fit still needs scrutiny. |
| free-drop-in-georgetown | Selects a birth-to-crawling group for a toddler; median judge 2. |
| named-venue-cartwheel | Follow-up quotes $140 despite empty verified picks; median judge 2. |
| travel-visit-new-york | Drops a potentially usable museum; no picks, median judge 2. |
| travel-visit-montreal | Drops the available museum reference; no picks, median judge 2. |
| travel-visit-ottawa-month-boundary | Reseller facts attributed to the museum, unsupported price; median judge 2. |
| nothing-running-underwater-basket-weaving | Automated pass, no invented class. |

These are legacy-harness diagnostics, not proof that every failing draft was sent
through the full production Coach path. No parent received a test message.

### Burlington: same URL does not mean same activity instance

The actual query retains `Burlington, Ontario, Canada` and `October 2026`.
The final reply gives future October sessions and says prices are unpublished,
not Free. But old detail-page age/category is attached to current widget sessions:

| Page | Main detail | Age quote offset | Current widget session offsets |
| --- | --- | ---: | --- |
| `bpl.libnet.info/event/3493126` | Jan 4, 2020 | 742 | 6635 / 8103 / 8896 / 16024 |
| `attend.bpl.on.ca/event/993654` | Sep 26, 2018 | 936 | 4803 / 12937 / 11861 |

The widget starts at offsets 1624 / 1728 respectively. The quote-presence check
passes, yet the fields belong to different page sections/instances. Old event
URLs are also reused for the current recommendations. This is the outstanding
ownership gap, not a successful Burlington acceptance.
[Actual picks, response and source/evidence positions](vil-423-burlington-2026-10-19.json).
First full reply: **84.376 seconds, N=1**. No new p50/p95 claim; the earlier N=4
64.982s / 76.385s measurement remains historical.

## Same-ledger spend, sealed after this run

| Work | New calls | Ledger USD |
| --- | ---: | ---: |
| Registration verification | 12 | 0.060592900 |
| Reminder/link writers + independent date parsers | 26 | 0.082256260 |
| Actual reminder/link judges | 12 | 0.173266600 |
| Finder search/extraction/follow-up/judges | 49 | 2.423362700 |
| Fresh Burlington full Coach case | 5 | 0.507344300 |
| **This approved pass** | **104** | **3.246822760** |
| **Original shared total** | **560** | **13.831651075 / 15** |

Remaining **$1.168348925** is not authority for another pass. Reserved $0, no new
refusal or halt; the one historical zero-spend count failure remains. The original
post-hold 143 calls / $7.341192700 disclosure is unchanged. Ledger usage estimates
are not a provider invoice; runner cost summaries differ, so the shared ledger is
the spend authority here.

SDK retries were disabled. The frozen Finder structured-output seam emitted one
bounded thinking-off re-ask; it is counted, not hidden or manually rerolled.
All 24 historical localized records are unchanged; 26 genuine entries were added.
81 new worker artifacts include real model/judge records and official-page caches.

## Handoff

Recordings and evidence are committed as failures where appropriate, not relabeled
green. Re-run Actions after push; the unchanged English and King assertions are
expected to remain red, so Build/repo-scripts cannot be claimed cloud-green if
skipped behind Test. Local root build/scripts results above are separate evidence.

Next decisions: resolve the English leg/guard contract without a paid reroll;
address extraction completeness, same-instance/age/price ownership and French
language-quality acceptance. No further paid recordings are authorized by this run.
No merge, deployment, production DB/watch edits, remote migrations or carrier SMS.
Unrelated VIL-337, Next and landing work is excluded.
