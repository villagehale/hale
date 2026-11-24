Original Claude Code brief for VIL-720 (written Nov 20, 2026, for a headless session). Parts that only applied to that machine are rewritten for a fresh clone of villagehale/hale on a Mac. The ticket's current state (branch, PR, what is done and left) is in the handoff file next to this brief and in the Linear ticket; it wins over this brief where they differ. Make reasonable decisions and record them in the PR body.

## Where you are
- Working directory: your clone of villagehale/hale. Branch: cc/vil-720-bring-items. Run `pnpm install` first. Base is main. Run `git fetch origin` and make sure your head contains origin/main before opening the PR.
- Flag for the new behavior (default off, declared in @hale/flags, enabled only when the value is exactly 'true'; no direct process.env flag reads): BRING_ITEMS_REMINDER_ENABLED. The final name is yours to pick if the proposed one is wrong; declare it and say so in the PR.
- PR title: "feat(reminders): bring-items from email and flyers in the night-before reminder (VIL-720)" (opened as DRAFT, base main).

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
# VIL-720: Bring-items: read what to bring from emails and flyers and put it in the night-before reminder
URL: https://linear.app/villagehale/issue/VIL-720/bring-items-read-what-to-bring-from-emails-and-flyers-and-put-it-in

**Dec 1 scope, item 6 (Barton approved 2026-11-19).** Owner: Claude Code session CC4 (Barton reviews and merges). Target merge: **Nov 25**. Flag: default-off, name proposed `BRING_ITEMS_REMINDER_ENABLED`.

## Goal

If an email or flyer says what to bring (swim bag, towel, indoor shoes, permission slip), the night-before reminder says it.

## Scope

* Extract bring-items from the source email or flyer/screenshot with the model (facts only; no guessing), store them against the event with provenance.
* The existing night-before reminder (6 PM family-local, via Linq) and the 1-hour-before reminder include the items when present. `LOOP_SEND_ENABLED` has been ON in Prod since Nov 19 9:18 PM ET, which also enables the 1-hour-before reminder, so test both.
* Email-derived items never reach a group chat or another parent (group privacy rule).
* No items found means the reminder is unchanged; never invent items.

## Acceptance criteria

* Fixture emails and flyers (incl. French and a screenshot) yield the right items; a prompt-injection email cannot add items ([VIL-560](https://linear.app/villagehale/issue/VIL-560/prompt-injection-eval-suite-for-email-calendar-and-web-content-before)).
* The reminder text stays fully AI-written; if the model fails, nothing is sent and #ops is paged.
* The Sunday week-ahead is retired: do not add bring-items to any weekly digest.
* Tests pass with the flag on and off; pin the clock in date tests.

## Rules that apply

Fully AI-written parent copy; no regex or word lists; Linq only; no STOP/HELP. Full list: Linear document 'Claude Code handoff: Dec 1 launch'.

## Related

[VIL-689](https://linear.app/villagehale/issue/VIL-689/prove-the-approved-multi-family-group-scenes-end-to-end-live-on) (bring-list in groups), [VIL-687](https://linear.app/villagehale/issue/VIL-687/shared-list-items-get-an-owner-ill-get-mia-the-lego), [VIL-560](https://linear.app/villagehale/issue/VIL-560/prompt-injection-eval-suite-for-email-calendar-and-web-content-before), [VIL-662](https://linear.app/villagehale/issue/VIL-662/teamcoach-schedule-changes-read-a-coach-league-or-team-app-email).


## Definition of done
1. Implement the item per the issue, handoff and rules above, flag off by default.
2. Run lint (biome lint on your changed files / `pnpm lint`), typecheck for the touched packages, and the touched tests, with the flag on and off. Fix everything until green locally.
3. Commit, push your branch (`git push -u origin cc/vil-720-bring-items` unless instructed otherwise above), and open a DRAFT PR against main with `gh pr create --draft --base main` using the title above (check `gh auth status` first). PR body: what changed, the flag name and default and how to turn it on/off, tests run, "Eval spend: $0.00 (recording pending)", open risks, and the Linear link: https://linear.app/villagehale/issue/VIL-720/bring-items-read-what-to-bring-from-emails-and-flyers-and-put-it-in. Do not merge. Do not mark ready.
4. Stop when the PR is open and green locally. Put a short summary (PR URL, flag, tests run, open risks, anything you could not do) in the PR body and as a comment on the Linear ticket, and print it as your final message.


Also: commit and push a draft PR as soon as a flag-off slice is working; do not wait until the end; do not exit while waiting on background work.
