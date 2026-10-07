# Landing redesign — downloaded October 2026 handoff

Local review draft. Implementation lives in `/private/tmp/hale-landing-main-redesign`, branch `feat/vil-428-landing-redesign` (renamed from `fix/landing-redesign-main`), based on main `586017f8`. Tracking: [VIL-428](https://linear.app/villagehale/issue/f55c5b6c-ba72-42c1-a131-01cd3596b32a), G5 · Marketing, Site & Brand. The original checkout and earlier experiments are preserved. Local checkpoint committed on the working branch at the user’s request; no push, merge or deployment. Linear issue created October 7.

## Preview and source

- Stable local production preview: http://localhost:3005/ .
- Source: Linear document `landing-redesign-homepage-subpages-oct-2026-30027e4efc56` and the user’s downloaded folder `/Users/yuhangsong/hale/.local/drive-download-20261007T144707Z-1-001`.
- Both supplied HTML source archives, their screenshots, shore artwork and turtle asset were used. Closed #765/#766 were not the implementation baseline.

## Implemented

- English homepage and `/pricing`, `/faq`, `/about`, `/activities`, `/answers`, `/for-centres`, `/contact`, `/text`, `/privacy`, `/terms`.
- Supplied shore composition, weekly calendar, group conversation phone, product chapters, tier cards and shared header/footer. No message-to-calendar morph.
- Source fonts connected to existing self-hosted fonts. Display weight calibrated to 400 for the screenshot’s regular appearance on macOS. CSS motion is the supplied slow shore drift; reduced-motion stops it. No new dependencies.
- Active Text Hale actions reuse the device-aware chooser and existing SMS prefill. `/text` preserves platform URI forms, source attribution, feature-flag greetings, QR, contact card and copy-number behavior. Missing-number deployments offer email.
- Guide stage filters work; published guide destinations and body content remain in the existing corpus. FAQ jump links work, with JSON-LD generated from the visible supplied FAQ data. Founder LinkedIn and contact email actions use real destinations.
- Legal pages use shared chrome and the shore presentation. Existing policy body, updated dates, disclaimers and section anchors are retained.
- Supplied catalog: Free; Plus $19 CAD/mo or $159 CAD/yr; Max $39 CAD/mo or $329 CAD/yr. Internal `family` entitlement key stays unchanged. Shared `PLAN_DISPLAY` updated so the app and marketing display agree; billing and entitlement enforcement unchanged. Paid actions are disabled and clearly coming soon.
- Dated city guides remain reachable, but the new activities index no longer advertises them. Archived guide/city pages retain their existing presentation.

## Scope still pending review

The new source says to regenerate FR/ZH after English copy is locked. Those routes retain the earlier local translated draft, with shared prices and legal presentation; they are not translations of this new English design. Barton must clear outward copy before merge. See `landing-redesign-copy-review.md`.

## Verification

- Site: 48 test files, 449 tests passed. Obsolete visual/copy assertions were replaced with the new design contract; SMS wiring, legal text, published routes, metadata, translations and existing library checks remain covered.
- Shared plan display: 12 tests passed, including CAD prices and annual savings.
- TypeScript, changed-file Biome lint/import checks, production build and `git diff --check` passed.
- Real Chrome production-preview checks: desktop 1440×900, mobile 390×844, tablet 768×1024 and narrow phone 365×812. No horizontal overflow at checked widths; supplied images loaded on all ten subpages.
- Exercised guide filters, copy-number feedback, theme control, FAQ/hero anchors; inspected composer prefill/source attribution and live QR geometry. No SMS sent. No console errors in the final browser session.
- Source/rendered screenshot comparisons and capture metadata: `.local/design-qa/`. Report: project-root `design-qa.md`.
- No physical iPhone or live SMS delivery test.

## Local setup

`apps/site/.env.local` contains only the public Linq number already supplied in `.env.example`; no launch secrets copied. Worktree dependency symlinks point the shared plan package at the worktree build. Preview runs `next start --hostname localhost --port 3005` after a successful production build.


### October 7 motion follow-up

Hero confirmation → calendar → driver/shared status, four in-view yearly-service examples, and scoped button feedback are implemented in the local draft. Native Web Animations/Intersection Observer; no animation dependency. Replay, reduced motion and complete static markup retained. See `design-qa.md` motion pass and `.local/design-qa/motion/` for evidence. Preview remains `http://localhost:3005/`.

Group-chat examples are now a native horizontal scroll-snap gallery. Only the settled center card plays; other cards show complete static previews. Switching replays the selected conversation, with buttons, keyboard arrows and horizontal swipe support. Desktop/mobile production checks, 5 focused tests, Biome and build/type validation passed. See the gallery follow-up in `design-qa.md`.

### October 7 iPhone gallery follow-up (VIL-428)

The three group-chat slides now use the existing realistic iPhone plate with live iMessage-style group headers and blue/gray bubbles. Finite three-dot typing indicators precede incoming replies; only the settled center scene plays. Phone geometry and narrow-screen spacing are verified at 1440/390/320px. Six focused tests, Biome and production build/type validation passed. Evidence and runtime-warning notes: `design-qa.md`, `.local/design-qa/phone-gallery/`. Preview remains http://localhost:3005/#group-chats.

Follow-up: conversations now start directly under the group header; the phone bottom is cropped, showing approximately the upper three quarters with extra content height only where narrow screens require it. Chat waits are roughly one third shorter. All three conversations remain within the crop at 1440/390/320px, and center-only typing is verified. No new assets or dependencies.

Dark-mode follow-up: gallery iMessage screens now follow the site theme, using black backgrounds, white text/status icons and gray incoming/typing bubbles. The realistic black handset plate remains unchanged; themed screen/status overlays avoid inverting the body. Light mode retains the white interface.

All-handset follow-up: the homepage hero now shares the gallery's native theme tokens, including its status icons, composer and home indicator. All four handset screens were verified black in dark mode and white in light mode. No other handset renderer was found in the current site subpages. Screenshot: `.local/design-qa/phone-gallery/dark-hero.png`.

Message-artifact follow-up: the annual-flow conversations/notification/reminder, logistics memory conversation and `/text`, Activities and For centres previews now use the same native dark theme. All were checked in the browser. Evidence: `.local/design-qa/phone-gallery/dark-year-previews.png`.
