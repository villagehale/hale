# VIL-423 — review fixes and one remaining recording estimate

October 19, 2026. PR #872 stays draft; #872 first, #871 paused. Main is already
integrated. This checkpoint spends **$0 / 0 new model calls**. Paid calls remain
held until Barton approves this consolidated checklist. No merge, deployment,
remote migration, production watch edit or carrier SMS.

## Free fixes

| Before | Current code / verification |
| --- | --- |
| CI expected the retired `eval:civic-hours` job | Removed that stale expectation; repo-script tests 64/64 pass. |
| Seven opaque Civic-hours cassettes remained | Reconstructed their exact keys from the deleted runner, skill and lane at `98686395f^`; removed only those seven. They are recoverable in Git. No Civic runner, command or workflow remains. |
| Link writer received `confirm_plan_in_approvals` | Now receives `confirm_by_reply_in_this_chat`; writer instructions ask for a natural chat reply, not an approvals webpage or prescribed answer. |
| Reminder skill described reply options | Pending/moved-date confirmation points to chat. Check-in asks how registration went, without a menu or response keywords. |
| Chat-confirm path was assumed | A local PGlite test runs a model-resolved, non-fast-path reply through the real approval handler/spine and verifies approval plus enqueue. Link/approval mechanics: 23/23 pass. This is not a new model-language test. |
| Corrupted historical French was tied to the changing writer prompt | It is now a historical negative input to the real date verifier. Wrong-date and quoted-wrong-weekday controls remain. All three replay successfully without new calls. No historical reply is re-keyed to answer a changed prompt. |

The paid acceptance set now also includes **pending-plan heads-up** and
**post-registration check-in**, because the original eight reminder cases did not
exercise those two prompt rules. Tests still fail on genuine missing recordings;
no skip, fake reply or weakened acceptance floor was added.

## Local verification

Tested an isolated `f3c1174` snapshot plus only this checkpoint's edits, excluding
the unrelated dirty watch-control/Next/landing work.

| Check | Result |
| --- | --- |
| Full Web | **10,537 pass / 14 skip / 13 fail**; all failures are the ten reminder and three link writer recording misses after this prompt/input change. |
| Historical date controls | **3/3 pass**: corrupt French, wrong opening date, quoted wrong weekday. |
| Worker mechanics | **441 pass / 1 skip**. |
| Agent | **157 pass**. |
| Repo scripts | **64 pass**, including the repaired workflow expectation. |
| Typecheck / production build / root lint | Pass; existing lint warnings remain. |
| Prompt lock | **76/76** match in the release snapshot; unrelated local skill excluded. |
| Registration eval calibration | All 12 deliberately broken answers fail its checks; calibration passes, zero API calls. |
| Registration cached-only | Fails at the first missing key `b6282cc4…`, as in CI; offline inventory finds all 12. |
| Prepared acceptance runner | Fixture/hash/ledger `--check` passes, zero API calls. |

This is **not** all-green CI or new AI-wording acceptance. The previous GitHub
E2E run passed, but the old Workspace/Worker run was red; the pushed head needs a
fresh Actions run, which will remain red on genuine missing recordings until approval.

## French byte investigation

Historical writer key:
`7955e39a49b474a8979e267f1f5f465e9045a122ec92505bd5a616e32cd3e058`.

- Recording file is valid UTF-8. Its content exactly matches the first saved SDK
  response in the original acceptance log; `readStructuredAnswer` returns the same
  bad message unchanged.
- Reproduced the reported signature: UTF-8 `è` bytes `c3a8` decoded as Windows-1257
  become `ĆØ`; similarly `û → Ć»`, `ê → ĆŖ`, `à → Ć` plus a nonbreaking space.
- No such decoder was found in the recorder, structured parser or recording runner.
  The installed SDK's non-streaming path uses `response.json()`.
- **Original HTTP response bytes were not retained.** An SDK response object is
  not wire-byte evidence. We can rule out the later recorder/parser changing it,
  but cannot honestly assign origin to the model versus an earlier layer.
- No speculative character replacement or product decoder patch. The prepared
  next recording captures cloned HTTP response bytes and the SDK object, so the
  already-required French reminder regeneration can settle this without a separate
  paid reroll. It has only run `--check` so far, with zero requests.

## Missing-recording audit

Worker registration verification has **12 missing current keys**, not only the
first miss that aborts CI. None was found in committed history under its current
key. Three fixtures are new; the other nine use changed prompt/schema requests
(strict schema, unclassified eligibility and timezone/year evidence). Existing
older answers cannot be relabeled as answers to those changed requests.

| Fixture | Current key |
| --- | --- |
| us-course-source-zone | `b6282cc4a120e1c0897d5bcd659b65c11539812f3ac6674a146383c055588022` |
| uk-course-date-only | `5d22fbc936b03a4d171f7e332332bb726e4c4049abd9cd5fe79facc77853bf8e` |
| weekday-unique-year | `58b5156f134450c76eadeaf0f2e70da6abdf5686c8b70d5200791b19ed6c4557` |
| markham-fall-2026 | `8e19c51a79a5c0ec1a5c08486a66d7c54c22a828d5660f499e9b74e472d771cc` |
| markham-other-cycle-same-page | `39f120e65800e2d243ce835681d3bdada29309054a61ff0e5c829c15ce3c9e5a` |
| toronto-arc-rule-is-not-a-date | `548f441344a5329639d406f8f53dfd4f13f891d50bed6dd308d48068d7dd0ef4` |
| burlington-table-row | `4b22417fddfada1a43a52e24be928eb2d06ce0316cee6324e10537cf010e5cd5` |
| king-cross-year-registration | `5974dd7c277acd255deb7de6641b5a7acbbd71af65c2a2808d079568dd131f34` |
| stale-prior-year-trap | `d86de8c296835adaee590866e35b2624231c7bf9cb10bf2f4249aaa29ccf1173` |
| toronto-announced-later | `2e781c0992d681c901eee34d173b81effaecd4927aa6ba1f354081185995e5fb` |
| halton-hills-no-table | `48ea001fba52d54091716979f4bfd3cd1c08987f285325ff395562edf085646c` |
| no-year-stated | `dac80384f91e17cb21b984f4c95b00956758d19d91696fa2d6c771fb293a6541` |

The Finder official-page cache remains missing after the harness was aligned with
the production pinned reader. Older search-prose-based answers are not substitutes
for those page inputs. Unchanged journey/Coach/deep recordings remain reusable.

## Frozen prompts and inputs

| File | SHA-256 |
| --- | --- |
| registration-reminder.md | `b7826a0ee9983d65e672b17243c02fed7d69611d94bc49c0c67edddf516573bd` |
| registration-link-reply.md | `938fdb04c2abd1598f6882664d8cf5ed1f8e8d6a3b227a2053131b49fce00650` |
| registration-message-dates.md | `2fb8889cc325391c1d7934af2762a1ee23eea4e260fbc70501606cc9f59ada24` |
| verify-registration-window.md | `0dcf51439958ca0291ee0bcfbb59d74b96245340e4f10e40c94d8e33cc3e0d67` |
| activity-finder.md | `319f2bb36e10c9bcff84f0d013c6cc3c1ec6f076ff22122f075cc7d0af4fdf8a` |
| coach-channel-sms.md | `90654daa82f3e66992c7f6e8ccddfdf02f0719be18b943b9e7bdc52b7db31298` |
| link-reply.ts | `1e17bd9968c7f3c94264038cc072fc7cd15a9436bbd72cf08b2cd4415a6fec5d` |
| testing/registration-acceptance.ts | `6f2005ec0cf9ddc4de2380622bdc5090f95e7a22b281963ec98e8f9512456e0e` |
| run-registration-verify-eval.mjs | `12583db84911f89c0754c19010579a287623db2d950afb601412001de307a1ac` |

Frozen [recording rubric](vil-423-recording-rubric-2026-10-19.md) hash:
`6d6aa022ecc220a641919bee0d8716c794b72dea19e851591301dd4df908de15`.
It additionally checks chat confirmation and no reply menu; date/fact/language
floor is unchanged. Notice-style tone, I/we voice and long URLs are explicitly
not new blockers in this pass. A later prompt/input change invalidates this freeze.

## ONE remaining paid estimate — awaiting approval

Same original ledger: **$10.584828315 spent / 456 calls**, reserved $0;
**$4.415171685 remains** of the original $15 ceiling. The one historical zero-spend
count preflight failure remains in the audit; no budget refusal, reset or new cap.
Previously disclosed post-hold work remains **143 calls / $7.341192700**; this
checkpoint adds zero. These are ledger usage estimates, not a provider invoice.

| Work, in priority order | Expected allowance |
| --- | ---: |
| 12 registration-verification cases above | $0.25 |
| 10 reminders + EN/FR/Arabic link replies; existing-model factual/language judges | $0.30 |
| Independent date-parser calls on those 13 messages; unchanged negative controls replay | $0.05 |
| Legacy Finder 8 cases including required official-page inputs/cache, extraction and judges | $3.30 |
| One Burlington current-instance ownership check plus bounded repair contingency | $0.45 |
| **Additional / expected cumulative** | **$4.35 / $14.934828315** |

This supersedes earlier remaining-work estimates; it is **not** another allowance.
Basis: the previous 11-message regeneration plus controls used $0.22427706;
the Finder/Burlington allowances are retained from the reviewed estimate. The
registration allowance is a local request-size/output-budget estimate, not a
new API call. Expected cost leaves only about **$0.065** inside the cap, so completion
is not guaranteed: reserve each call's maximum charge, sequentially, SDK retries
disabled. A budget refusal stops all further calls, even if expected usage is lower.
If it will not fit, leave Finder/Burlington incomplete and report; no second ledger
or reroll-until-pass.

Exact reminder cases: `open-en`, `open-fr-CA`, `full-en`, `full-ar`,
`closing-soon-en`, `closing-soon-fr-CA`, `unconfirmed-en`, `unconfirmed-ar`,
`pending-en`, `check-in-en`. Link cases: `link-en`, `link-fr-CA`, `link-ar`.
The French recovery is part of this one changed-prompt run, not an extra reroll.
Saved official HTML and a historical clock are explicit; no live carrier send.

Exact legacy Finder cases: `toddler-fall-programs-halton-hills`,
`preschool-swim-oakville`, `free-drop-in-georgetown`, `named-venue-cartwheel`,
`travel-visit-new-york`, `travel-visit-montreal`,
`travel-visit-ottawa-month-boundary`, `nothing-running-underwater-basket-weaving`.
One fresh `burlington-storytime` check must distinguish a 2020 detail page from its
current widget and require current-instance age/date ownership. No unsupported
Free, fallback to stale dates, or relaxed geography/age/date gates.

After approval: record once; post verbatim successes **and failures** with parsed
dates/source context on Linear before committing recordings; replay all tests and
run real GitHub Actions. Fresh reply timing is recorded, not promised: previous
N=4 nearest-rank p50/p95 **64.982s / 76.385s** is unchanged by free tests.

Post-merge/out of this pass: tone review, whole-email-thread/dedup design note,
older English/time regex follow-up, VIL-337 and production catalog cutover.
Unrelated local Next/landing/watch-control edits are excluded.
