# VIL-423 — corrected order and one paid acceptance request

**Barton approved one run, hard cap US$15**, confirmed in [Sloane's 16:07 note](https://linear.app/villagehale/issue/VIL-423#comment-52281b88).
No paid calls had been made at that original prompt checkpoint. #872 merges first; #871 follows.
Main is already integrated at `e3450b8eb`; no further rebase is requested.
Keep the US ZIP implementation and migration numbers in this branch.

## Hold audit, regeneration approval and ONE remaining-work estimate

Sloane's [19:06 hold](https://linear.app/villagehale/issue/VIL-423#comment-6162a367)
and [21:44 review](https://linear.app/villagehale/issue/VIL-423#comment-2f48b7d7)
superseded the original recording permission for further calls. Barton subsequently
[approved regeneration at 21:53](https://linear.app/villagehale/issue/VIL-423#comment-3ecfb375),
inside the SAME $15 ledger: first push structured dates/semantic guard/no STOP regex
and post the spend breakdown; then eight reminders, then EN/FR/Arabic links.
No regeneration has started at this source checkpoint. The same original ledger
stands at **$10.360551255 / $15, 422 calls**, reserved $0. It is an estimate from
returned usage/tool counts, not a provider invoice; it has not been reset.

| Covered work | Calls | Ledger USD |
| --- | ---: | ---: |
| Reminders, links, intent and sample judges | 26 | 0.199572355 |
| Missing journey subjects and judge recordings | 11 | 0.062031100 |
| Coach subjects and judges, including harness-alignment continuation | 272 | 3.270094200 |
| Legacy Finder search, extraction, judges, including truncated/failed attempts | 61 | 4.258458400 |
| Four fresh Finder → Coach conversations | 22 | 2.089006100 |
| Deep-answer subjects, repairs and judges | 30 | 0.481389100 |
| Total | **422** | **10.360551255** |

**Yes, calls ran after the 19:06 hold was posted.** I did not refresh the review
promptly enough. Batch order/log times identify the Finder batches, Coach alignment,
four fresh conversations and deep eval as later work: **143 calls / $7.341192700**.
The ledger has no per-call timestamps, so this is batch-level attribution, not an
invented timestamp audit. The last batch finished around 21:39 ET, before I read
and acknowledged the hold. Nothing paid has run since that acknowledgement.

**One re-estimate covering all remaining paid acceptance: $4.10 expected**, inside
the **$4.639448745 remaining** on the SAME ledger:

| Remaining work | USD allowance |
| --- | ---: |
| Legacy Finder eight cases, real official-page inputs, extraction and judges | 3.30 |
| Regenerate eight reminders and EN/FR/Arabic links; existing-model voice/fact judges | 0.30 |
| Independent natural-date parser checks on those eleven messages | 0.05 |
| Repairs, HTTP/page-input variability and one Burlington ownership check/sample | 0.45 |
| Expected additional / cumulative | **4.10 / 14.460551255** |

This is a planning estimate based on this session's usage, not a guarantee that
all cases fit. The $15 gate reserves worst-case call costs; stop and report if it
refuses, even if the expected cost would fit. No reroll-until-pass, new ledger or
additional run is authorized. Unchanged Coach/deep/journey replay costs $0.

The new writer input is `{date, time, timeZone, timePublished}`. A separate existing
Haiku `screen` call sees only the generated message and clock, parses its expressed
values, then code compares them with the source facts. No new API/provider. This
adds one validation call per generated reply; real quality/latency is **unverified
while held**. The prior multilingual samples do not accept this changed prompt.

Current keyless prompt checkpoint (not permission to regenerate):

| File | SHA-256 |
| --- | --- |
| registration-reminder.md | 1be0e78d90a85bfa6bc2d08fb9e1e8c5a2b8488c6c6385013cfb1da265e23475 |
| registration-link-reply.md | 52d72c4358bbe106dc2cd42e8b2dbbaa1b94021aa6507b44cd80fa38fee45f33 |
| registration-message-dates.md | 2fb8889cc325391c1d7934af2762a1ee23eea4e260fbc70501606cc9f59ada24 |

The original checkpoint below is retained as the audit for the earlier calls;
the reminder/link hashes are superseded by the three above.

## Keyless changes before recording

- The two registration-link word lists are replaced by one structured request
  reading. A high-confidence reminder request can enter the existing reviewed
  approval path. Bare links/questions are not consent; unrelated, uncertain or
  failed readings cannot approve a plan or create a watch.
- Missing search location is read by the same model request contract, not a
  `near me` word list. Without a confident scope, ask for a city/course link;
  never search a guessed city. Supplied URLs still bypass discovery.
- Reminder context carries the watch owner's stored language tag, unchanged,
  through the existing household compose-once path. No new language detector.
- Cold migration replay moves to the existing database setup hook, not a longer
  test-body timeout. All migration assertions and send/consent gates remain.
- All registration-link outcomes now go through `registration-link-reply`; no
  fixed English reply/fallback. The generated proposal also supplies its approval
  rationale/title rather than an English template. Unsafe URLs/credentials are
  removed from model input; a failed writer holds the reply and logs the outcome.
- The reminder sees the existing `readSpot` state/evidence from the same fetched
  course bytes, so a full fixture is not simulated by inventing a closed/full fact.
- Reuse the existing shared spend ledger, sequential processes only. Disable
  hidden SDK retries under the cap; application retries are separately reserved.

The word-list change is limited to the three reviewed sites. It is not a claim
that every older intake module is keyword-free. The English evidence/time regex
follow-up remains outside this change, as Sloane marked it non-blocking.

Acceptance-session correction, without changing the frozen product prompts or model:
the evidence/session JSON exceeded the former 1,024-token extraction output budget.
The production Finder and eval now both allow 2,000 tokens for that one step.
The extra maximum output allowance is under $0.01 per extraction at the same model
rate; it stays inside the same US$15 shared total cap, not an additional spend run.
The Coach eval also now offers the real `read_registration_page` tool and watch-only
context, instead of pre-injected dates with a required tool missing. Judge context
receives the existing spot policy only on a spot-watch turn. No voice/factual floor
or assertion is relaxed; valid cached outputs remain unchanged.

## Prompt checkpoint

| File | SHA-256 |
| --- | --- |
| registration-request-read.md | c0cb5b024a52d3a042e7eca105bf4ce7a36b6d7189fac64495c6b2bf2aa06550 |
| registration-reminder.md | b2ac4f66e72c74c26a64c42920fef1f0fc957fdfb59bc0610904b3154ab6800c |
| registration-link-reply.md | 3b314d0fb171e92c447d94340e7e7f87b9aa66aefc8e9a1c1b36bd0184408999 |
| activity-finder.md (unchanged) | 319f2bb36e10c9bcff84f0d013c6cc3c1ec6f076ff22122f075cc7d0af4fdf8a |
| coach-channel-sms.md (unchanged) | 90654daa82f3e66992c7f6e8ccddfdf02f0719be18b943b9e7bdc52b7db31298 |

Recording must use the committed #872 tree, without the separate uncommitted
VIL-337 watch-control work or user-local Next/landing changes. Further prompt
changes invalidate this checkpoint and require an updated estimate before calls.

Keyless verification of that isolated source: full Web **10,485 passed, 14 skipped,
9 missing-recording failures**; related 673 passed / 2 live skips, Agent 157,
typecheck, production build, root lint and 74 prompt hashes pass. No paid calls.

## One run, approximately US$12 expected / US$15 total ceiling

These are planning allowances, not a provider quote. The approved run stays within
the same $15 total; no second run is authorized.

| Work | Allowance |
| --- | ---: |
| ~12 Finder/Coach fact cases (legacy 8-case quality corpus + 4 fresh Coach checks) | $8 |
| ~8 AI reminder outputs plus existing-model judge grades | $1 |
| New link/intent readings and missing journey/Coach/deep recordings, reusing unchanged entries | $2 |
| Search/cache/retry allowance | $1 |
| Expected total | **$12** |
| Additional contingency; total requested ceiling | **$15** |

Basis: the earlier four-case live run used roughly 1.20M uncached input and 24.8K
output tokens, about $2.65 base token cost; three comparable batches are about
$7.94 before tools/cache/retry charges. [Official pricing](https://platform.claude.com/docs/en/about-claude/pricing),
checked October 16: Sonnet 5.5 $2/$10 per million input/output tokens; Opus 5.5
$4/$20; short-prompt Haiku 5.5 $0.10/$0.50. Cache and tools have separate charges.
This matches the repository token estimator; actual billed usage may differ.

The cap covers the whole recording session, including retries, judges, tool/cache
charges and missing-recording repairs, not $15 per script. Before live execution,
admit calls only with their maximum estimated charge reserved against the shared
remaining budget; do not launch an unbounded batch or retry automatically past it.
If the remaining work cannot fit, stop and report the unfinished cases rather
than silently exceeding the ceiling or claiming CI passed. This document does not
claim that unwrapped diagnostic scripts enforce the gate: every live client used
in this session is wrapped with `capSdkClient`, and processes run sequentially.

## Acceptance output

- ~12 Finder/Coach cases: date, age, unknown price/Free, opening, resident-only,
  all-year hours without confirmed dates, moved official URL, US ZIP, non-GTA
  Canada, French, conflicting-source research, and could-not-confirm. Include
  linked reminder/negation and missing-location intent checks in this allowance.
- ~8 reminder cases collectively cover English, French and Arabic, and open,
  closing-soon, full and unconfirmed states. Save exact input/live source, raw
  generated text, final sent-shaped body and judge result. Keep failures visible.
- Repair the 9 missing-recording journey failures and the cached-only Coach miss
  in this same capped session; never fabricate replies or re-key old answers.
- Post verbatim reminder samples for Sloane after approved generation. Current
  fixtures prove wiring, not multilingual model accuracy or voice acceptance.
- Post those samples on Linear before committing any new recordings. If budget
  refuses a call, stop the session and post unfinished coverage; no second run.
- Run GitHub Actions on the resulting committed recordings. First substantive
  reply p50/p95 remains a follow-up measurement, not a claim from fixture timings.

No production deploy, migration/drop, real watch edits, carrier SMS or booking.
The production catalog drop still needs a backup, maintenance window and Barton's
separate approval. VIL-337 remains a separate, lower-priority change.
