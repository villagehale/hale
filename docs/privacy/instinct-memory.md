# Instinct-style memory (Hale)

Hale keeps family memory in Postgres in the Canadian region. This note is the privacy surface for the v1 described in the draft that added the memory brief, lexical search, and daily/weekly digests. It is not a claim that Hale copies Instinct's generator. That generator was not published.

## What is stored

- **Facts** stay on `family_memory_facts` (bi-temporal, with confidence, writer, source event, and supersede links). No new fact types. VIL-391 adds `memory_kind`, `memory_source`, `sourced_at`, `expires_at`, and `signal_count`. Existing rows are `lasting` / `legacy`. The columns are ignored unless `FAMILY_MEMORY_KINDS_ENABLED` is exactly `true`. Parent-facing sentences for that path are locked copy and still do not send unless `FAMILY_MEMORY_KINDS_COPY_LOCKED` is exactly `true`.
- **Aliases** (`family_memory_aliases`) are normalized tokens from a fact's key plus a fixed synonym list in the repo (`daycare` / `childcare`, relationship words, and similar). Message text cannot add an alias.
- **Digests** (`family_memory_digests`) are one row per family, grain (`day` or `week`), and local period start. The JSON is counts and closed labels (channel category, conversation topic, commitment kind). It does not store a message body.
- **Promise kinds** in the memory brief (`workstreams:`) are open `agent_commitments` rows. The brief shows kind, topic, and due time, not the commitment sentence. That ledger is a closed set of debts Hale already spoke (`first_find`, `activity_followup`, and the other kinds), at most one open row of each kind, written by the surface that made the promise. It has no status column and no free-form title.
- **Active jobs** (`family_workstreams`, VIL-419) are a different table: threads Hale is in the middle of (a search still waiting on a pick, a wait for a third party, a reminder), with a title, a status, a next step, and an expiry. They are not identity facts and they are not commitments. A commitment cannot hold eight concurrent jobs or a declined-versus-scheduled status, and a job title is parent conversation, which the promise ledger refuses to store. A declined or rejected activity is stored as `dropped`, never as a confirmed plan. When `WORKSTREAMS_ENABLED` is exactly `true`, the compact job block is appended to `memoryBrief.text` under `active_workstreams:`. It is not a second context field. A job title is not copied onto the `workstreams:` line, and a commitment kind is not copied into the job block. Extracting a row and storing it require the flag to be exactly `true`. While it is off, a turn does not call the extractor and does not write. The proactive check-back stays off unless the flag is exactly `true`. A thread linked to a 13+ child is left out of the prompt and is not followed up by text. The extractor is given each child's id, first name, and age, plus recent event ids, so a turn that names a child can be linked; an id that was not in that list is dropped. A check-back time is read in the family's timezone, and a time already in the past is not stored.

Deleting a family cascades these rows. Deleting a fact cascades its aliases.

## What an agent sees

Each Ask Hale and SMS turn receives `memoryBrief`: a bounded text block (1,800 characters) of high-confidence live preferences, logistics, relationships, autonomy, open promise kinds (`workstreams:`), and digest lines. Medical values, receipt keys (`health_checkpoint:`, `registration_outcome:`), and any fact attributed to a 13+ child are left out. A digest older than its freshness window is labeled `stale`. If the read fails, the brief is `unavailable` and empty — the turn does not invent a replacement. With `WORKSTREAMS_ENABLED` exactly `true`, the same text gains one `active_workstreams:` section (700 characters, at most six jobs) after that budget. The skills already say to read `memoryBrief`; there is no parallel workstream field on the turn.

Search tools on Ask Hale are read-only except `save_memory` (a parent statement or correction, which supersedes the prior row) and `forget_memory` (retires a row). Forgotten rows leave the brief and default search. History is a separate call. SMS does not get those tools; it only sees the brief.

## Flags

Both default off.

| Env | Effect |
| --- | --- |
| `MEMORY_DIGEST_APPLY` | Must be exactly `true`. Anything else, including `true` with a trailing newline, stays observe-only. |
| `MEMORY_DIGEST_FAMILY_ALLOWLIST` | Comma-separated family ids. Apply does nothing unless this is non-empty, and then only those families are written. |
| `WORKSTREAMS_ENABLED` | Must be exactly `true`. Anything else, including `true` with a trailing newline, leaves extraction, writes, the prompt block, and the check-back sweep off. |

Observe mode writes an audit row (`memory_digest_planned`, `applied: false`) when a digest would be added or updated. It does not insert digest or alias rows and does not close facts.

`MEMORY_SYNTHESIS_APPLY` is unchanged and still gates the nightly duplicate/stage retirement pass. The digest job does not close those rows.

## Export and audit

`/api/rights/export` includes `memoryDigests` as grain, period, timezone, and counts. The rollup line is omitted. Audit rows for digest, alias index, ephemeral retirement, and forget store ids and counts, not fact values or message text. Family-memory facts are not in that snapshot yet (VIL-388). `toFamilyMemoryExportFact` in `apps/web/lib/memory/kinds.ts` is the hook that snapshot should call so kind and source travel with each fact.

## Lexical limit

Search is exact normalized tokens plus the synonym list. A typo (`pazta` for `pasta`, an extra character on a name) does not match. There is no vector index and no third-party memory processor.
