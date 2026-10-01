# Family memory export and backup (VIL-388)

Proposal only. No schema change, no new table, no new route. This note records what a family record is today, then a snapshot shape a later change could write.

Parent of this work: [VIL-364](https://linear.app/villagehale/issue/VIL-364/epic-year-loop-retention-before-paid). Privacy surface for the memory brief itself: `docs/privacy/instinct-memory.md`.

## What we store today, and where

Postgres, Supabase Toronto. Per-family rows cascade when `families` is deleted. `scheduleFamilyDeletion` stamps the grace window; `runDeletionSweep` in `apps/web/lib/rights/delete.ts` is what the cron at `apps/web/app/api/cron/delete-sweep/route.ts` runs once that stamp is due.

### Memory subsystem

| Store | Table | What a row holds |
| --- | --- | --- |
| Facts | `family_memory_facts` | `fact_type` is the enum `preference`, `routine`, `medical`, `logistic`, `relationship`, `voice` (`packages/db/src/schema/enums.ts`). Key, JSON value, confidence, writer, source event, `valid_from` / `valid_until`, `superseded_by`. Partial unique live row per `(family, child, type, key)` is migration SQL, described in `packages/db/src/schema/memory.ts`. Writer: `apps/web/lib/memory/facts.ts`. |
| Episodes | `family_memory_episodes` | `occurred_at`, `episode_type`, `summary`, JSON payload, optional sentiment, `authored_by`, soft `deleted_at`. |
| Aliases | `family_memory_aliases` | Normalized token from the fact key or the closed synonym list. Message text cannot add one (`apps/web/lib/memory/aliases.ts`). |
| Digests | `family_memory_digests` | One row per `(family, grain, period_start)`. `summary` is counts and closed labels. `content_hash`, `source_count`. Observe-only unless `MEMORY_DIGEST_APPLY` is exactly `true` and `MEMORY_DIGEST_FAMILY_ALLOWLIST` is non-empty (`apps/web/lib/memory/digest.ts`). |
| Open promises | `agent_commitments` | Kind, short summary, due time. The brief treats these as workstreams (`packages/db/src/schema/agent-commitments.ts`). |

Nightly duplicate and stage retirement is `MEMORY_SYNTHESIS_APPLY` (`apps/web/lib/memory/synthesis.ts`), exact `true`. A parent can retire one belief fact with `forgetFamilyFact` (`apps/web/lib/memory/forget.ts`). Receipt keys (`health_checkpoint:`, `registration_outcome:`) are refused. Forgotten rows leave the brief and stay in history.

The agent brief (`docs/privacy/instinct-memory.md`) is a bounded text block. It omits medical values, receipt keys, and facts attributed to a 13+ child.

### The year record around that memory

These are family data the year loop acts on. They are not rows in `family_memory_facts`.

| What | Where |
| --- | --- |
| Kids | `children` — given name, optional last name, date of birth, `dob_precision` (`exact` or `derived`), gender, interests (`packages/db/src/schema/children.ts`) |
| Household | `families` — display name, country, province, city, postal code, coarse area, intents, plan tier, `scheduled_deletion_at` |
| Parents | `users` plus `family_members` (role `primary_parent` or `co_parent`) |
| This week's plan | `week_plans` — one row per `(family_id, week_start)`, JSON `items`, optional `summary` and `voice`. A recompose updates that row (`packages/db/src/schema/week-plans.ts`) |
| Calendar occasions | `family_events` |
| Booked classes | `activity_bookings` — title, first session, provider host, parent, connection, message id. No confirmation number, amount, or child name (`packages/db/src/schema/activity-bookings.ts`) |
| How it went | `activity_reviews` — verdict and tags, no free-text sentence |
| Evening notes | check-in notes, requester-scoped. `NOTE_RETENTION_DAYS` is 30 in `apps/web/lib/channel/checkin/notes.ts` |
| Consents | `consent_records` — type, scope, granted, evidence JSON for an SMS yes (`packages/db/src/schema/consent.ts`) |
| Signup attempts | `authorized_signup_offers` — host, status, session id. Form values are not columns |
| Saved activities | `village_saves` joined to candidate titles |
| Audit | `audit_log` — append-only |

## What a parent can already download or delete

`GET /api/rights/export` builds `FamilyExportDocument` in `apps/web/lib/rights/export.ts` and writes a `data_exported` audit row. The button is `apps/web/components/hale/export-data-button.tsx`.

The document includes family basics and children, members, unconfirmed call names, saved activity titles, assistant connections (no tokens), registration preparation (host only), watched spots (host and state), activity bookings (title, time, host, calendar flag, cancellation), authorized signups (host, status, session id, time), the requester's evening notes, activity reviews, the requester's trips, memory digests as grain / period / timezone / counts, and the teen-redacted trail.

It does not include `family_memory_facts` values, episodes, aliases, `week_plans.items`, `family_events`, or `consent_records`. Digest prose is omitted on purpose (`docs/privacy/instinct-memory.md`).

`POST /api/rights/delete` calls `scheduleFamilyDeletion`. The grace window is 7 days (`DELETION_GRACE_MS` in `apps/web/lib/rights/delete.ts`). A second request does not move the stamp. Clearing `families.scheduled_deletion_at` cancels it. A co-parent's request departs that parent rather than scheduling the household. After the stamp, the worker deletes the family row and the cascades follow. `forgetFamilyFact` is the single-fact path and is not this route.

## Proposed snapshot

One JSON document per family per version. Version field is an integer on the document, starting at `1`. A later reader refuses a version it does not know.

```json
{
  "format": "hale.family_snapshot",
  "formatVersion": 1,
  "familyId": "<uuid>",
  "exportedAt": "<ISO-8601>",
  "contentHash": "<sha256 of the canonical JSON below this key>",
  "memory": {
    "facts": [],
    "episodes": [],
    "digests": []
  },
  "year": {
    "children": [],
    "weekPlans": [],
    "familyEvents": [],
    "activityBookings": [],
    "activityReviews": [],
    "consents": []
  }
}
```

Rules for v1, matching the privacy already in the export:

- Facts keep key, type, value, confidence, writer, validity, and supersede link. A fact attributed to a 13+ child is included only as type plus "redacted", the same omission the brief already makes.
- Episodes include summary and payload for parent-authored rows. A teen-authored episode (`authored_by` null and the child is 13+) is redacted the way the trail is.
- Digests stay counts and closed labels.
- Week-plan items keep the structured `WeekPlanItem` fields. Voice strings are included because they were shown to the parent.
- Bookings stay title, time, host, and cancellation. No message body.
- Consent rows include type, scope, granted, times, and policy version. Evidence text is the parent's own words and is included for the requesting parent only.
- Aliases are omitted. They are derived from keys.
- Passwords, verification tokens, OAuth tokens, inbound forward tokens, and integration secrets are omitted. `credentials` and `integrations` token columns are not part of this document.

Canonical JSON is UTF-8, object keys sorted, no insignificant whitespace, then SHA-256. That hash is what a backup stores beside the bytes.

## Versioning and rollback

Facts already version themselves: a correction inserts a new live row and sets `valid_until` and `superseded_by` on the old one (`writeFact`). Digests upsert one row per period and keep `content_hash`. Week plans overwrite the same `(family, week)`.

The snapshot does not become a second writer. Rollback of a proposed snapshot restore:

- Facts: insert a new live row copied from the snapshot value, superseding whatever is live now. Do not delete the intervening row. History stays.
- Digests: upsert only when the snapshot `contentHash` differs, and only for periods the snapshot names.
- Week plans: write the snapshot items onto that `week_start` and append an audit row `family_snapshot_restored` with the snapshot hash, not the item bodies.
- A restore refuses to run when the family's `scheduled_deletion_at` is set.

There is no git history of these rows today. The audit log is an event list, not a restorable tree.

## Backup cadence

What exists:

- `infra/README.md` documents Supabase daily backups, 7-day retention, Toronto region.
- `.github/workflows/deploy.yml` names Supabase PITR as the manual restore when a migration is bad. The workflow comment does not state the PITR window. That number is unverified here.

What this proposal adds, later, still in the Toronto project:

- A daily job writes one snapshot per family that changed since the previous hash (facts, episodes, digests, week plans, bookings, reviews, consents). Unchanged families write nothing.
- Keep 30 daily snapshots and 12 monthly snapshots per family. That is longer than the 7-day database backup so a parent can ask for last season without a full-project restore.
- The object store is the existing private `family-docs` bucket (the avatar key in `packages/db/src/schema/children.ts` already points there), key `snapshots/{familyId}/{exportedAt}.json`. No new vendor.
- The job logs `skipped: 'not_configured'` when the bucket is absent (hard rule 11). It does not pretend a snapshot was written.

Database backups remain the disaster-recovery copy. Family snapshots are the parent-scoped copy.

## Parent-visible export and delete

Export: extend `FamilyExportDocument` with a `memory` section (live facts, redacted as above, plus episodes the requester may see) and a `weekPlans` section. Same route, `GET /api/rights/export`. The button already downloads that JSON. A parent sees the same redaction an export already applies to the trail: a 13+ child's raw content stays out even if a teen-access grant is active (`export.ts` calls the trail loader without an unlock set).

Delete:

- One fact: the existing `forgetFamilyFact` path, surfaced in the export as a fact id the parent can name. Receipt keys stay refused.
- The household: the existing 7-day scheduled deletion. Snapshots for that family are deleted in the same sweep that hard-deletes the family, not before the grace window ends, so a cancel still has the rows.
- A single snapshot object is not a substitute for erasure. Erasure is the family delete.

No code in this ticket implements the snapshot, the extra export sections, or the object-store job.
