# VIL-423 — corrected order and one paid acceptance request

**Pending Barton's approval. No paid calls made. #872 merges first; #871 follows.**
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

The word-list change is limited to the three reviewed sites. It is not a claim
that every older intake module is keyword-free. The English evidence/time regex
follow-up remains outside this change, as Sloane marked it non-blocking.

## Prompt checkpoint

| File | SHA-256 |
| --- | --- |
| registration-request-read.md | c0cb5b024a52d3a042e7eca105bf4ce7a36b6d7189fac64495c6b2bf2aa06550 |
| registration-reminder.md | be6af31c5300ffcdf8dd3c7f6553b5e8f190849f64d8980030f90fb4b455ef1d |
| activity-finder.md (unchanged) | 319f2bb36e10c9bcff84f0d013c6cc3c1ec6f076ff22122f075cc7d0af4fdf8a |
| coach-channel-sms.md (unchanged) | 90654daa82f3e66992c7f6e8ccddfdf02f0719be18b943b9e7bdc52b7db31298 |

Recording must use the committed #872 tree, without the separate uncommitted
VIL-337 watch-control work or user-local Next/landing changes. Further prompt
changes invalidate this checkpoint and require an updated estimate before calls.

Keyless verification of that isolated source: full Web **10,485 passed, 14 skipped,
9 missing-recording failures**; related 673 passed / 2 live skips, Agent 157,
typecheck, production build, root lint and 74 prompt hashes pass. No paid calls.

## One run, approximately US$12 expected / US$15 total ceiling

These are planning allowances, not a provider quote or approval:

| Work | Allowance |
| --- | ---: |
| ~12 fresh Finder/Coach fact cases | $8 |
| ~8 AI reminder outputs plus existing-model judge grades | $1 |
| New intent readings and missing journey/Coach recordings, reusing unchanged entries | $2 |
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
claim that the existing diagnostic scripts already enforce that admission gate.

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
- Run GitHub Actions on the resulting committed recordings. First substantive
  reply p50/p95 remains a follow-up measurement, not a claim from fixture timings.

No production deploy, migration/drop, real watch edits, carrier SMS or booking.
The production catalog drop still needs a backup, maintenance window and Barton's
separate approval. VIL-337 remains a separate, lower-priority change.
