# Instinct-style memory (Hale)

Hale keeps family memory in Postgres in the Canadian region. This note is the privacy surface for the v1 described in the draft that added the memory brief, lexical search, and daily/weekly digests. It is not a claim that Hale copies Instinct's generator. That generator was not published.

## What is stored

- **Facts** stay on `family_memory_facts` (bi-temporal, with confidence, writer, source event, and supersede links). No new fact types.
- **Aliases** (`family_memory_aliases`) are normalized tokens from a fact's key plus a fixed synonym list in the repo (`daycare` / `childcare`, relationship words, and similar). Message text cannot add an alias.
- **Digests** (`family_memory_digests`) are one row per family, grain (`day` or `week`), and local period start. The JSON is counts and closed labels (channel category, conversation topic, commitment kind). It does not store a message body.
- **Workstreams** are the existing `agent_commitments` rows. The brief shows kind, topic, and due time, not the commitment sentence.

Deleting a family cascades these rows. Deleting a fact cascades its aliases.

## What an agent sees

Each Ask Hale and SMS turn receives `memoryBrief`: a bounded text block (1,800 characters) of high-confidence live preferences, logistics, relationships, autonomy, open workstreams, and digest lines. Medical values, receipt keys (`health_checkpoint:`, `registration_outcome:`), and any fact attributed to a 13+ child are left out. A digest older than its freshness window is labeled `stale`. If the read fails, the brief is `unavailable` and empty — the turn does not invent a replacement.

Search tools on Ask Hale are read-only except `save_memory` (a parent statement or correction, which supersedes the prior row) and `forget_memory` (retires a row). Forgotten rows leave the brief and default search. History is a separate call. SMS does not get those tools; it only sees the brief.

## Flags

Both default off.

| Env | Effect |
| --- | --- |
| `MEMORY_DIGEST_APPLY` | Must be exactly `true`. Anything else, including `true` with a trailing newline, stays observe-only. |
| `MEMORY_DIGEST_FAMILY_ALLOWLIST` | Comma-separated family ids. Apply does nothing unless this is non-empty, and then only those families are written. |

Observe mode writes an audit row (`memory_digest_planned`, `applied: false`) when a digest would be added or updated. It does not insert digest or alias rows and does not close facts.

`MEMORY_SYNTHESIS_APPLY` is unchanged and still gates the nightly duplicate/stage retirement pass. The digest job does not close those rows.

## Export and audit

`/api/rights/export` includes `memoryDigests` as grain, period, timezone, and counts. The rollup line is omitted. Audit rows for digest, alias index, ephemeral retirement, and forget store ids and counts, not fact values or message text.

## Lexical limit

Search is exact normalized tokens plus the synonym list. A typo (`pazta` for `pasta`, an extra character on a name) does not match. There is no vector index and no third-party memory processor.
