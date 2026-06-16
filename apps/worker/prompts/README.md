# Prompts

Langfuse is the source of truth for prompt authoring and versioning (CLAUDE.md
hard rule #2). These `.md` files are the disk cache the runtime loader reads.

Lifecycle:

1. Edit a prompt **in Langfuse**, promote the version to the `production` label.
2. `pnpm --filter @hale/worker prompts:pull` — writes the new text to disk and
   refreshes `.langfuse-lock.json` ({name, version, sha256} per prompt).
3. Commit the changed `.md` files **and** `.langfuse-lock.json` together.

`prompts:check` (CI + offline) recomputes each file's sha256 against the
lockfile. A local edit without a `pull` makes it go red. `prompts:push` uploads
disk → Langfuse for the initial seed; push/pull need `LANGFUSE_*` env keys.

Local-first exception (no Langfuse keys yet): a brand-new prompt — or a
deliberate local edit before Langfuse exists — can't `pull` a version that
isn't there, so `check` would stay red with no offline path forward. Run
`node scripts/sync-prompts.mjs seed` to record each file's sha256 from disk
(`version` stays `null` until a real `pull` stamps it). Commit the `.md`
files and the refreshed `.langfuse-lock.json` together, same as a pull.

Stage-aware content packs live in `packs/<stage>.md` (newborn / toddler /
child / teenager) and are lockfile-tracked under the name `packs/<stage>`.
