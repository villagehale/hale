# VIL-423 — corrected order and one paid acceptance request

**Barton approved one run, hard cap US$15**, confirmed in [Sloane's 16:07 note](https://linear.app/villagehale/issue/VIL-423#comment-52281b88).
No paid calls made at this prompt checkpoint. #872 merges first; #871 follows.
Main is already integrated at `e3450b8eb`; no further rebase is requested.
Keep the US ZIP implementation and migration numbers in this branch.

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
