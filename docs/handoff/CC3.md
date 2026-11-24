Original Claude Code brief for VIL-719 (written Nov 20, 2026, for a headless session). Parts that only applied to that machine are rewritten for a fresh clone of villagehale/hale on a Mac. The ticket's current state (branch, PR, what is done and left) is in the handoff file next to this brief and in the Linear ticket; it wins over this brief where they differ. Make reasonable decisions and record them in the PR body.

## Where you are
- Working directory: your clone of villagehale/hale. Branch: cc/vil-719-ask-policy-tiers. Run `pnpm install` first. Base is main. Run `git fetch origin` and make sure your head contains origin/main before opening the PR.
- Flag for the new behavior (default off, declared in @hale/flags, enabled only when the value is exactly 'true'; no direct process.env flag reads): ASK_POLICY_TIERS_ENABLED. The final name is yours to pick if the proposed one is wrong; declare it and say so in the PR.
- PR title: "feat(agent): three-tier ask policy (VIL-719)" (opened as DRAFT, base main).

## READ FIRST
1. Read the full handoff file: docs/handoff/README.md (item table, workflow, and the hard rules). Also docs/handoff/hale-eng-handbook.md. Then in the repo: CLAUDE.md, REVIEW.md, docs/voice.md, docs/flag-rollout-checklist.md, plus the files named in your Linear issue.
2. The hard rules (section 3 of the handoff), quoted verbatim:

## 3. Hard rules (non-negotiable)

1. **Every parent-visible message is fully AI-composed from facts.** No templates, skeletons, code-assembled prefixes, or fallbacks. **If the model cannot write it, send nothing** (and page #ops). Only exception: the OTP login text.
2. **No word lists, regex or keyword matching to understand parent intent.** Use the model's meaning read. Links are detected only with `hasLinkShape` / `hasLinkBeyond`. Guard tests have exact-count allowlists that only go down; raising one needs Barton's own words in the PR body.
3. **Linq only, never Twilio.**
4. **No STOP or HELP** in messages or on the site.
5. **No Sunday week-ahead** (retired). Only the night-before and 1-hour-before reminders.
6. **No referral program, no gift-a-year.** (Barton reaffirmed Nov 19. Do not build item "referral codes".)
7. **Hale reports registration honestly:** say "registered" only after the provider's confirmation. No 7 AM race optimization.
8. **Promo flags and ads stay off until Barton says go.** Payment flows A to F stay flagged off.
9. **Never print secrets.** `ANTHROPIC_API_KEY_TEST` and Stripe keys: never print, echo or paste. No passwords, codes, reset URLs or keys in chat, PRs, logs or Linear.
10. **Paid evals follow the economy rules:** use `ANTHROPIC_API_KEY_TEST` only, develop with `--cached-only` / `--dry`, one paid run per PR, re-record only failures, put `Eval spend: $X.XX` in the PR body.
11. **Group privacy:** say only what every member present may hear. Health and payment details only in DMs. One parent's inbox content is never shown to another parent.
12. Every new behavior ships behind a **default-off flag declared in `@hale/flags`** (no direct `process.env` flag reads). Test with the flag on and off.
13. **Barton (or whoever he names) reviews and merges.** As of Nov 20 Noah is no longer on this work; Barton runs Claude Code himself. Do not message parents, post in group chats, or send outreach.
14. No fixed copy for caregivers, co-parents or anyone else either: the "parent" rule covers every human Hale texts.

## Extra rules from Noah/Barton for this run
- No fixed or template parent copy, ever (the OTP login text is the only exception). Every message a human receives is AI-written from facts; if the model fails, send nothing.
- No STOP or HELP anywhere. No regex or word-list intent detection (use the model's meaning read). No character caps. Linq only, never Twilio.
- All new behavior is behind a default-off flag that is exactly 'true' to enable. Test with the flag on and off.
- No referral codes or gift-a-year. No Sunday week-ahead.
- NEVER use GitHub stacked PRs (no stack_on). Base on main (or the PR branch named below).
- Spend model money only on what is necessary: tests/evals that call the model run with --dry / --cached-only and use cached recordings where the repo supports them. Never use any Anthropic key except ANTHROPIC_API_KEY_TEST, and do not record a paid eval unless Barton says so for this PR. State in the PR body which eval cases you added and that recording is pending ("Eval spend: $0.00, recording pending Barton's OK").
- Never print secrets. Never read, source or load any file holding Production values (a Prod env dump, `vercel env pull` output, a shell profile that exports Prod keys). Tests never run with Prod secrets loaded. Never read env files holding production values. Do not touch Vercel, Prod env, or PostHog/Linq/Stripe production settings; do not flip any flag in Prod; do not message anyone (parents, groups, Slack, email).
- Do not merge anything. Never push to main. Stage files explicitly; conventional commits; no --no-verify.
- Prompts load through loadPrompt (never inline). Dates in tests use pinClock / vi.setSystemTime. New DB-query tests use pglite. If a migration is needed, pick the number via `pnpm db:next-migration` after fetching.
- Raising a guard-test allowlist is forbidden (counts only go down).
- Keep runs light: run only the tests you touched (vitest on specific files, scoped typecheck such as `pnpm --filter <pkg> typecheck`), never the full monorepo test suite or `pnpm build` in parallel with unnecessary work.


## Your Linear issue (source of truth for scope), pasted verbatim
# VIL-719: Three-tier ask policy: just do it, tell after, or ask first
URL: https://linear.app/villagehale/issue/VIL-719/three-tier-ask-policy-just-do-it-tell-after-or-ask-first

**Dec 1 scope, item 4 (Barton approved 2026-11-19).** Owner: Claude Code session CC3 (Barton reviews and merges). Target merge: **Nov 25**. Flag: default-off, name proposed `ASK_POLICY_TIERS_ENABLED`.

## Goal

Hale knows, for every kind of action, whether to **just do it**, **do it and tell after**, or **ask first**, so it finishes tasks without nagging and never surprises a parent with money, commitments or other people.

## Scope

* Define three tiers and map every action class to one: e.g. reading and remembering (just do), calendar changes the parent already asked for (tell after), anything that spends money, registers a kid, contacts a third party, or touches another person's info (ask first).
* The tier decision is made in code from the action class and facts (not from reading words), and the text for each tier is AI-written.
* Respects the existing 5-streak autonomy rule (CLAUDE.md hard rule 4): nothing moves to 'just do' without explicit consent history. This ticket does not loosen autonomy gates.
* Documented in the repo (a short table in docs) so later work follows it.

## Acceptance criteria

* Table of action classes and tiers reviewed by Noah; tests prove ask-first actions never run without a recorded yes.
* Tell-after messages are fully AI-written; if the model fails, nothing is sent and #ops is paged (the action itself still follows its tier rules).
* Tests pass with the flag on and off.

## Rules that apply

Fully AI-written parent copy; no regex or word-list intent; Linq only; no STOP/HELP. Full list: Linear document 'Claude Code handoff: Dec 1 launch'.

## Related

[VIL-24](https://linear.app/villagehale/issue/VIL-24/autonomy-gates-entitlement-observation-5-streak-cross-parent) (autonomy gates), [VIL-711](https://linear.app/villagehale/issue/VIL-711/restate-the-understanding-in-one-line-before-a-sign-up-or-calendar) (post-launch restate-before-sign-up), [VIL-712](https://linear.app/villagehale/issue/VIL-712/learn-and-store-each-familys-judgment-rules) (post-launch family judgment rules).


## Definition of done
1. Implement the item per the issue, handoff and rules above, flag off by default.
2. Run lint (biome lint on your changed files / `pnpm lint`), typecheck for the touched packages, and the touched tests, with the flag on and off. Fix everything until green locally.
3. Commit, push your branch (`git push -u origin cc/vil-719-ask-policy-tiers` unless instructed otherwise above), and open a DRAFT PR against main with `gh pr create --draft --base main` using the title above (check `gh auth status` first). PR body: what changed, the flag name and default and how to turn it on/off, tests run, "Eval spend: $0.00 (recording pending)", open risks, and the Linear link: https://linear.app/villagehale/issue/VIL-719/three-tier-ask-policy-just-do-it-tell-after-or-ask-first. Do not merge. Do not mark ready.
4. Stop when the PR is open and green locally. Put a short summary (PR URL, flag, tests run, open risks, anything you could not do) in the PR body and as a comment on the Linear ticket, and print it as your final message.


Also: commit and push a draft PR as soon as a flag-off slice is working; do not wait until the end; do not exit while waiting on background work.
