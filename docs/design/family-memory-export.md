# Family memory export and backup (VIL-388)

Proposal only. No schema change, no new route, no snapshot writer here. Parent: [VIL-364](https://linear.app/villagehale/issue/VIL-364/epic-year-loop-retention-before-paid). Brief privacy: `docs/privacy/instinct-memory.md`. `toFamilyMemoryExportFact` in `apps/web/lib/memory/kinds.ts` is the fact shape a later file should call. No snapshot builder exists today.

## What we store today

Postgres. Rows cascade when `families` is deleted (`packages/db/src/schema/memory.ts`).

**Facts** (`family_memory_facts`). `family_id`, optional `child_id`, `fact_type` (`preference`, `routine`, `medical`, `logistic`, `relationship`, `voice` — `packages/db/src/schema/enums.ts`), `fact_key`, `fact_value` (JSON), `confidence`, `inferred_by`, `source_event_id`, `valid_from`, `valid_until`, `superseded_by`, plus VIL-391 `memory_kind`, `memory_source`, `sourced_at`, `expires_at`, `signal_count` (`packages/db/drizzle/0141_family_memory_kinds.sql`). One live row per `(family, child, type, key)` is partial unique index `memory_facts_one_live_per_key_idx` (migration 0084, noted on the table). `writeFact` (`apps/web/lib/memory/facts.ts`) closes the live row, inserts, then sets `superseded_by`.

**Kinds** (`apps/web/lib/memory/kinds.ts`): `lasting`, `temporary`, `one_off`. Sources: `parent_message`, `calendar`, `receipt`, `inferred`, `legacy`. Backfill is `lasting` / `legacy`. Readers ignore the columns unless `FAMILY_MEMORY_KINDS_ENABLED` is exactly `true`. `classifyMemoryWrite`: a supplied `expires_at` is `temporary`; age, date of birth, district, language, weekday care, and pickup or dropoff owner are `lasting` on the first write; an inferred preference or routine stays `one_off` until a second signal (the same fact again, a booking, or positive feedback), then `lasting`; a calendar row with no expiry is `one_off`; anything else is `lasting`. `temporaryExpiry` is seven days or 120 days. Expiry is a read-time filter (`isExpiredTemporary` in `apps/web/lib/memory/store.ts`). The row stays. Flag on, recommendations drop `one_off` and expired `temporary`. A parent recall still lists `one_off`.

**Writers.** Forgettable beliefs are only `ask-hale`, `memory_inferencer`, and `chat_distiller` (`SYNTHESIS_WRITERS` in `apps/web/lib/memory/synthesis.ts`). `ask-hale` is coach `save_memory` (`apps/web/lib/coach/tools.ts`, source `parent_message`) and a parent's correction (`correctFamilyFact` in `store.ts`, forced `lasting`). The nightly run (`apps/web/lib/cron/inference.ts`) calls the inferencer and the distiller (`save_child_fact` in `apps/web/lib/cron/inference-tools.ts`). The distiller reads 14 days and at most 60 turns, refuses confidence under `0.7` (`CONFIDENCE_FLOOR` in `facts.ts`), and `distill-guard.ts` drops an enrollment the parent did not say and a booking or event does not back. A 13+ child's turn is a category marker before the model sees it. Other `writeFact` callers (weekday care, health and registration receipts, co-parent duty, logistics polls, intake) are outside that allowlist, so `forgetFamilyFact` refuses them.

**How a row ends.** Supersede sets `valid_until` and `superseded_by`. A forget sets `valid_until` and leaves `superseded_by` null (`closeFacts`). A `temporary` row past `expires_at` leaves reads and stays stored. Nightly synthesis (`MEMORY_SYNTHESIS_APPLY` exactly `true`) may close a child-scoped `chat_distiller` routine the child has outgrown, and only once that row is at least 30 days old (`MIN_STALE_FACT_AGE_DAYS`). Flag off, it audits and does not close.

**Beside the facts.** Episodes (`family_memory_episodes`) hold summary, payload, optional `sentiment_score`, `authored_by`, and soft `deleted_at`. Aliases are key tokens plus a fixed synonym list (`apps/web/lib/memory/aliases.ts`). Digests are counts and closed labels, one row per `(family, grain, period_start)`. Kids are `children`. This week's plan is `week_plans`, overwritten per `(family_id, week_start)`. Neither is a memory fact.

## Snapshot format

One JSON document per family, built on request. Unknown `formatVersion` is refused. Each fact is `toFamilyMemoryExportFact` plus `value` (id, type, key, kind, source, `sourcedAt`, `expiresAt`, `invalidatedAt`). No second fact shape.

```json
{
  "format": "hale.family_snapshot",
  "formatVersion": 1,
  "familyId": "2c1e0000-0000-4000-8000-000000000001",
  "exportedAt": "2026-10-02T16:00:00.000Z",
  "facts": [
    {
      "id": "9b0e0000-0000-4000-8000-000000000002",
      "factType": "logistic",
      "factKey": "weekday_care",
      "kind": "lasting",
      "source": "parent_message",
      "sourcedAt": "2026-09-01T14:00:00.000Z",
      "expiresAt": null,
      "invalidatedAt": null,
      "value": "daycare"
    }
  ],
  "readable": "What Hale has saved for your family\nTaken 2 Oct 2026\n\nweekday care: daycare. Lasting. You told Hale.\n\nLeft out: other families, and Hale's private certainty numbers."
}
```

`readable` is file text. It is not a message, and this note does not send it. v1 is live rows only, with no 40-row cap (that cap in `recallFamilyMemory` is a message limit). Same omissions as recall: `child_id` of a teenager (`deriveStage` === `teenager`), and receipt keys `health_checkpoint:` and `registration_outcome:` (`apps/web/lib/memory/lexicon.ts`). `value` is whatever `displayFactValue` in `store.ts` already shows: a string, or one of `value`, `note`, `summary`, `text`, `name` inside the JSON.

## Versioning, rollback, backup

A correction already inserts a new live row and closes the old one. Week plans and digests overwrite one identity. There is no git tree.

**Recommended: no new store.** The parent file is a read of live rows on the existing export route. Rollback of one fact is `writeFact` of the file's value, which supersedes the live row and keeps history. Do not clear `valid_until`: the unique index allows one live row. Refuse when `families.scheduled_deletion_at` is set.

Disaster recovery stays Supabase daily backups, 7-day retention, Toronto (`infra/README.md`). `.github/workflows/deploy.yml` names PITR as the manual restore after a bad migration. The window length is not in the repo.

**Cost.** No new storage and no cron. A daily JSON object per family in the private `family-docs` bucket would be a second copy, and `purgeFamilyStorage` (`apps/web/lib/rights/delete.ts`) only removes chat attachments and avatars, so those objects would outlive the family. Storage itself is cents per family per year. The cost that matters is the purge gap. Add objects only if a parent must recover last season without a project restore.

## Privacy

No web page lists fact values. On iMessage, `familyMemoryKindsHandler` (`apps/web/lib/memory/handler.ts`, wired in `apps/web/lib/channel/router/wiring.ts`) claims a turn only when the kinds flag is exactly `true`. The parent texts `what do you know`, `forget <key>`, or `correct <key>: <value>` (French shapes are in `parseMemoryParentIntent`). The reply is null unless `FAMILY_MEMORY_KINDS_COPY_LOCKED` is also exactly `true`. `recallFamilyMemory` returns lasting, unexpired temporary, and one-off beliefs, newest 40, dropping receipts and teen-attributed rows. `GET /api/rights/export` (`apps/web/lib/rights/export.ts`, button `apps/web/components/hale/export-data-button.tsx`) includes digest counts and not fact values.

Keep the file off the thread. A later phrase on that handler would point at the existing download. The reply is a placeholder and is never sent:

`TODO-Design: your family record is ready to download from the receipts page.`

`deliverMemoryKindCopy` refuses a body that still contains `TODO-Design`, so this line cannot leave until the placeholder is removed and both flags are exactly `true`.

One belief: `forgetFamilyFact` (`apps/web/lib/memory/forget.ts`). Receipt keys and non-belief writers are refused. The household: `POST /api/rights/delete` stamps `scheduled_deletion_at` for 7 days (`DELETION_GRACE_MS`). A second request does not move the stamp. A co-parent's request departs that parent and does not schedule the household. After the stamp, the sweep deletes the family and the cascades follow.

Left out: other families (every read is `family_id`); `confidence`, `signal_count`, and episode `sentiment_score`; aliases; digest prose; tokens. Teen-attributed values stay out even if an in-app grant is active. The export trail loader is called without an unlock set.

## Open questions and tickets

1. Live rows only, or closed history in the same file?
2. Episodes and `week_plans.items` in v1, or later? v1 above is facts plus `readable`.
3. iMessage: a link to the download, or an attachment? Do not attach. The thread is not the archive.
4. Is 7-day database retention enough? Add object copies only if a parent needs last season without a project restore.

- Extend `FamilyExportDocument` with `facts` (the hook plus `value`) and `readable`, on the same GET. Tests: teen omission, receipt omission, no score fields.
- An iMessage phrase on `familyMemoryKindsHandler`. Reply stays null while the body contains `TODO-Design`.
- Only if question 4 is yes: a weekly object in `family-docs` when the live-fact hash changed, and that prefix inside `purgeFamilyStorage` before the family row goes.
