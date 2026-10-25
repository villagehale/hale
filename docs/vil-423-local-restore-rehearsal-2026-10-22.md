# VIL-423 local custom-archive recovery rehearsal — 2026-10-22

Status: **local synthetic rehearsal passed; production cutover gate NOT cleared**.

No production data, credential, connection, backup, DDL, platform pause/resume, environment change, model call or SMS was used. No cloud project/add-on was created. Source head is unchanged at `adc851ace18e556ddd61353a8541502187c1c1f6`.

## What actually ran

- Native, signature-verified Postgres.app PostgreSQL **16.15**, downloaded from its official release. Repository guidance lists PostgreSQL 16; the live production minor version was not verified here.
- A new disposable cluster under `/private/tmp/vil423-local-restore.OFhMx7/run-03`, Unix socket only, TCP listening disabled. No system service was installed or existing database/container changed. Test server was stopped in `finally`.
- **167 real pre-0172 migration files**, unchanged, plus their constructed Drizzle ledger. This is not a copy of the live production ledger/exemptions.
- **10,000 synthetic catalog rows**, two synthetic families/parents/children, saves, endorsements, share, event/action provenance, authorized signup offer, review and plan. The unused rows and a cross-family action reference must not be retained.
- Four explicitly **simulated**, non-operator-owned schemas (`auth`, `storage`, `realtime`, `extensions`), each with one synthetic sentinel table. They reproduce an ownership boundary, not Supabase's real managed-schema definitions, extensions, ownership grants or services.
- Operator role `postgres`: **NOSUPERUSER**, BYPASSRLS; owns application schema/tables, has SELECT/USAGE but not ownership of the simulated managed objects. Separate local bootstrap superuser is used for cluster setup and the complete archive integrity restore.

Rehearsal harness: `/private/tmp/vil423-local-restore.OFhMx7/rehearse.mjs`. Artifacts, including the custom archive and its table of contents, remain in the private temporary directory; they contain synthetic data only. The harness uses the existing runbook's before/after SQL and cleanup SQL, not a rewritten retention rule. A rerun requires a fresh local run directory; it refuses to overwrite an existing cluster.

Cleanup status: all task-created PostgreSQL servers are stopped, and the read-only native tool image is unmounted. Approximately 419 MB of temporary synthetic clusters, archives, harness, source DMG and server logs are retained; no user database or Docker volume was removed.

Migration tested byte-for-byte: `packages/db/drizzle/0172_activity_history_only.sql`.

SHA-256: `c27984d8792aeed143d3e669290b2539b3be1b5dd6b100509bf0738357d0c433`.

## Actual outcomes

| Check | Observed result |
| --- | --- |
| Full, unfiltered `pg_dump --format=custom` | Success; **915,574 bytes**; includes public, drizzle and all four simulated managed schemas |
| Complete archive restored into an isolated empty database by local bootstrap superuser | Success; all rows, table ownership/columns/defaults, constraints, indexes, RLS and sequence state match the source baseline |
| Apply actual 0172 plus its ledger entry in one transaction | Success; **8** expected history rows; both old tables removed |
| Saves / endorsements / shares after migration | **2 / 2 / 1**; category overlap retained; IDs/ownership match expectations |
| Runbook ID/FK reconciliation | Missing/extra owned IDs **0**; missing save/endorsement refs **0**; both new FKs validated; history RLS enabled |
| Reapply 0172 after retirement | Safe no-op |
| Deliberately delete a saved row | Unchanged reconciliation assertions reject the missing save; negative control passes |
| Exact runbook cleanup of the new history FKs/table | Success, no CASCADE |
| Whole-archive clean restore by the non-owner operator | **Expected failure** on a simulated managed table; single-transaction restore leaves its pre-restore state unchanged |
| Barton's alternative: restore only public + drizzle from that SAME full archive | Success as the non-superuser operator; no grant/escalation, no `--no-owner`, no new/partial archive |
| Post-rollback comparison | **104 tables**: row counts and canonical row-content digests match; table structure/ownership, FK definitions/validation, indexes, RLS and sequence state match; all simulated managed sentinels unchanged |
| Pre-cutover schema/ledger | Old catalog/rank and original save/endorsement FKs restored; history absent; 0172 ledger hash absent |
| Archive integrity | SHA-256 unchanged before/after the failed and successful restore paths |

Expected non-owner error, from real PostgreSQL (synthetic object):

```text
pg_restore: error: could not execute query: ERROR:  must be owner of table rehearsal_sentinel
Command was: ALTER TABLE IF EXISTS ONLY storage.rehearsal_sentinel DROP CONSTRAINT IF EXISTS rehearsal_sentinel_pkey;
```

## Measured local timings

| Step | Seconds |
| --- | ---: |
| Bootstrap all real pre-0172 SQL files | 1.388 |
| Capture baseline data/structure | 0.891 |
| Whole-database custom dump | **0.095** |
| Full archive restore as bootstrap superuser | **0.403** |
| Compare full restore with baseline | 0.911 |
| 0172 and ledger commit | **0.029** |
| Exact runbook reconciliation | 0.011 |
| Missing-save negative control | 0.017 |
| History/FK cleanup | **0.008** |
| Expected full-restore permission failure | 0.040 |
| Scoped public/drizzle rollback | **0.365** |
| Compare rollback with baseline | **0.890** |

Each measurement includes local CLI/process overhead. They are **not production downtime estimates or proof of meeting T+20**: the archive is under 1 MB, most unrelated tables are empty, no production data distribution/volume or network path was used, and Vercel quiescing/build/promotion and message retries were not exercised. Production dump time starts after T0 and must be included in the approved timing budget.

## Concrete rollback alternative demonstrated

After the existing reviewed cleanup of the migration-created history FKs/table, keep the **full archive** and restrict only the restore selection:

```bash
pg_restore --dbname="$PGDATABASE" --schema=public --schema=drizzle \
  --clean --if-exists --single-transaction --exit-on-error \
  "$VIL423_BACKUP_DIR/full-before.dump"
```

This is the alternative described in [Barton's October 22 review](https://linear.app/villagehale/issue/VIL-423#comment-a2b973eb), now exercised on a simulated ownership boundary. The snapshot still covers the entire database. Managed schemas are intentionally not rewound in the scoped path; their writes must also remain frozen, and cross-schema dependencies/extensions need review against the actual project before this becomes an executable production plan. The history cleanup is a separate transaction, as the existing runbook states; failure of the later restore does not undo that cleanup.

## Test-harness failures retained, not business fixes

1. Docker could neither pull PostgreSQL 16 nor create a container from the existing 17 image: its VM reported `no space left on device`. No pruning, volume deletion or existing-container changes were performed. The native PostgreSQL 16 fallback was used instead; no PostgreSQL 17 acceptance is being substituted.
2. First native run stopped before backup on a harness JSON reader splitting multi-line `json_agg` output. Fixed the harness to use one-line JSONB output. No application/migration change.
3. Second native run restored the archive and all row contents, but a raw schema-text assertion rejected PostgreSQL's equivalent flattening of nested AND parentheses in CHECK constraints. The checker now compares CHECK expressions after PostgreSQL's own planner normalization; FK/unique/check identity and validation remain checked. It does not delete arbitrary parentheses or skip CHECKs. No migration or acceptance threshold was changed. Final run passed all checks.

Archive SHA-256: `efab3bb5399b4f34b863b3ed8ebce5ded2993b6f3ea3be713ca870774dcc73bf`.

Combined baseline comparison SHA-256: `e2b78d359fe3d5924def3f4deb113792b7ef8b144c29450c6a2f6caea34016cb`.

## Still not verified / authority boundary

- The user confirmed there is **no existing approved full production archive available**. None was exported here; the current no-production-action restriction remains.
- Actual Supabase role grants, managed schemas/extensions, archive completeness/restore permissions and production-sized timings require the separately approved real backup/rehearsal step. This simulation alone does not satisfy Sloane's complete operational rehearsal gate.
- No production pause/retry test or measured Vercel build/promotion path; no backup upgrade, cutover schedule or merge authorization. Barton still owns backup arrangements and evening go/abort.
- This report documents local evidence only. Publishing it does not establish production recovery readiness, deployment or model-quality acceptance. The temporary harness/archive are not committed; no work on #875 was included in this rehearsal.
