# October 2026 supplied-design QA

final result: passed

## Sources, state and normalization

- Source visual truth: `/Users/yuhangsong/hale/.local/drive-download-20261007T144707Z-1-001/home-{desktop,mobile}.png`, hero/section crops, and `subpages/*-{desktop,mobile}.png`.
- Implementation: production build served at `http://localhost:3005`, English, light theme, no authentication, configured public texting number. Native product previews remain light within the dark page theme.
- Source homepage: 2880×13724 desktop (@2x, 1440×6862 CSS); 1170×32703 mobile (@3x, 390×10901 CSS). Final desktop implementation: 1440×6867, 1:1 capture. Mobile implementation uses the 390 CSS viewport and 1:1 capture. Full per-route pixel dimensions and normalization are in `.local/design-qa/capture-metadata.json`.
- Tested viewports: 1440×900, 390×844, 768×1024 and 365×812. The source densities were divided by 2/3 before compositing; browser chrome excluded. The long mobile privacy page exceeds the capture service’s full-page limit, so its hero was captured separately; its entire policy and footer were checked at desktop and its mobile width verified.

## Comparison evidence

All paths below are relative to this worktree (`/private/tmp/hale-landing-main-redesign`). Each comparison contains source and implementation in the same image.

- Full homepage: `.local/design-qa/home-desktop-compare-full.png`, `home-mobile-compare-full.png`.
- Focused hero: `hero-desktop-compare.png`, `hero-mobile-compare.png` in the same directory.
- Ten subpages: `{pricing,faq,about,activities,answers,for-centres,contact,text,privacy,terms}-{desktop,mobile}-compare-full.png`.
- Readable details: `pricing-detail-compare.png`, `text-detail-compare.png`, `answers-detail-compare.png`, `privacy-detail-compare.png`, `terms-detail-compare.png`.
- Additional states: `home-tablet.png`, `home-small.png`, `home-dark-desktop.png`, `answers-dark-mobile.png`.
- Browser measurements: `desktop-metrics.json`, `mobile-metrics.json`.

## Findings and comparison history

1. **[P1, resolved] Fonts and existing styles changed the source’s appearance.** Local font family names were not the registered Next font names; global styles also overrode layered source rules. Connected Source Serif/Figtree to existing local font variables, used regular display weight 400 on macOS, and scoped the source rules outside the component layer. Revised hero composites show the intended heading weight, wrapping and layout. Phone UI has minor system-font variation from the reference’s capture platform.
2. **[P2, resolved] Tablet phone overlapped the copy.** The responsive `zoom` calculation had incompatible units and was ignored. Dividing by a pixel width produces a valid ratio. The final 768px browser measurement puts the copy’s right edge at 372px and the visual’s left at 403px. Widths 768px and 365px have no horizontal overflow.
3. **[P2, resolved] Pricing page lost its founding-family strip.** Restored the supplied strip below the shared pricing cards. The final pricing detail comparison includes the real prices, feature lists and strip.
4. **[P1, resolved] Production optimizer removed nested custom properties.** Development screenshots were correct but the first production capture lost spacing/colors. Flattened the supplied CSS to ordinary scoped selectors. Final built CSS retains `--s5:24px` and related variables; the production hero/page now match the reference. This was verified from the actual production browser, not inferred from a successful build.
5. **[P2, resolved] Subpage-only first-section rules affected the homepage.** The first homepage chapter became centered and lost top padding. Restricted those rules to roots with `.sp-stage`. The revised full-page composite restores left alignment and the reference rhythm; final desktop height differs by 5px from the normalized reference.
6. **[P2, resolved] Dark-theme preview contrast.** Pale highlight text was unreadable on the amber event and a global field rule darkened the iMessage composer. Product preview surfaces and pricing cards now retain their native light scheme; the composer background is transparent. Final browser measurement: event ink `rgb(23,41,74)` on `rgb(254,240,199)`. Secondary calendar text uses the repository’s dark meta token. Dark screenshot inspected after the fix.

There are no remaining actionable P0/P1/P2 design findings.

## Required fidelity surfaces

- **Typography:** Helvetica Neue display, existing self-hosted Source Serif 4 body, Figtree UI and JetBrains Mono. Main/section heading sizes, alignment and wrapping compared at readable hero/detail scale. Regular display weight compensates for macOS weight mapping. Small native conversation text can wrap differently across operating systems (P3).
- **Spacing/layout:** Supplied 1200px grid, 12 columns, overlapping phone/calendar, section order, radii, footer alignment and responsive stacks. Compared full view and focused regions. Narrow/tablet overflow fixed and checked.
- **Colors/tokens:** Navy/page/card/cream/amber connect to repository tokens. Source artwork and soft section washes retained. Paid disabled controls are distinct and readable; dark previews use a light native surface.
- **Assets:** Original supplied shore WebP and turtle JPEG, plus the existing real wordmark/turtle chrome. Supplied SVG and HTML product UI retained; no generated or hand-drawn replacement assets. Ten desktop route checks found zero unloaded/broken images.
- **Copy/content:** Supplied English sections and real prices retained. `/text` intentionally previews the actual configured backend greeting instead of invented mock copy. Existing legal/guide body retained, so legal page body height/content is intentionally different from the source mock. These differences preserve actual product behavior and current documents.

## Interaction/accessibility checks

- Guide filters: Toddler yields five guides; Teenager yields two; All stages restores fifteen. Selected buttons expose `aria-pressed`; result count is live text.
- Actual copy-number button shows Copied; prior empty clipboard restored. No external message sent.
- Shared theme switch exercised both directions. Native language select and locale navigation retained; new FR/ZH copy regeneration remains outside this draft’s completed scope.
- Hero “See how it works” and FAQ jumps target real section IDs. Guide and founder/contact links have real destinations.
- `/text?s=design-review`: both inspected Apple SMS links use the ampersand URI form and contain the source token; the token is not visible page text. QR comes from the same live URI. No SMS was sent; no live delivery or physical iPhone test.
- One primary H1 per route, shared navigation/footer, visible keyboard focus, button target minimums, descriptive composite labels and reduced-motion CSS. Supplied slow shore drift stops for reduced motion.
- Final fresh production browser session: no error/warning console entries.

## Gates and follow-up

- Site: 449 tests in 48 files passed. Shared plan model: 12 tests passed.
- TypeScript, changed-file Biome lint/import checks, production build and diff whitespace check passed.
- P3 polish: small OS-dependent phone glyph/line-break differences, and the shared footer’s native controls instead of static mock controls.
- Copy and release approval remain separate: Barton must clear outward copy (including the new source’s STOP wording versus the earlier Slack lock and rollout availability claims). FR/ZH regeneration follows that English lock. This QA pass does not authorize merge/deployment.


## Motion pass — October 7

- Added an isolated `HomeMotion` client component using native Web Animations and Intersection Observer; no dependencies added. Server markup remains complete when scripts are unavailable.
- Hero: Jen confirmation at 0.6s; Hale reply at 1.6s; calendar plan at 2.5s; driver at 3.2s; shared status at 4s. Each entrance takes 400ms, with 8px travel and the existing breathe easing. Final state stays still; the native button replays only the hero. Mobile uses 70% of the sequence spacing and 4px travel (3.2s total).
- The hero waits for 60% visibility. Each yearly-service example observes its own artifact, so the lower cards do not finish playing before the parent reaches them. Examples pause outside the viewport and when the browser tab is hidden; returning resumes unfinished playback. Completed examples do not automatically repeat.
- Scoped CTA hover/press and stage-selection transitions use 200ms. Reduced motion cancels product animations, restores the complete static content and hides replay; CSS disables the new feedback transforms/transitions.
- Production regression found and fixed: CSS minification converts time units (`1000ms` to `1s`). Script timing now uses explicit unitless millisecond tokens; the final browser reads 400/1000 on desktop and 400/700 on mobile.
- Verification: changed-file Biome checks, TypeScript/build, and 5 focused tests passed (4 landing checks + 1 lifecycle/replay/reduced-motion check). Reduced-motion changes were exercised in the logic test; the user's OS setting was not changed.
- Real Chrome production checks at 1440×900 and 390×844: no horizontal overflow; keyboard replay works; hero opacity observations at desktop 1.9s and mobile 1.4s confirm chat precedes the calendar, and every target is fully visible at 4.5s/3.3s. Mobile lower service examples remain pending until scrolled into view.
- Screenshot evidence: `.local/design-qa/motion/hero-{desktop,mobile}-{start,middle,complete}.jpg`, `hero-desktop-overview.jpg`, `year-desktop.jpg`, `year-mobile-find.jpg`, `year-mobile-follow-up.jpg`. The desktop yearly-service frame is from development; hero frames and mobile service frames are from the final production build.
- Still a local review draft; no merge, push, deployment, billing or product capability changes.


### Group-chat follow-up

The three group-chat examples now reuse the existing motion controller. The opening question stays visible; replies appear in sequence, then RSVP/driving/reminder outcomes settle. Birthday: Hale 0.6s → parent confirmation 2.2s → RSVP 3s. Carpool: Tom 0.6s → Hale 1.6s → driving 3s. Swim: Hale 0.6s → reminder 2.2s → parent success reply 3s. Each sequence lasts 3.4s desktop / 2.5s mobile, with no loops or changes to layout/copy. Long chat scenes wait for 60% visibility; short yearly-service artifacts retain 20%.

Final production checks: all three desktop scenes progressed from hidden replies to intermediate replies to complete outcomes; at 390px only the first scene played, the second remained pending until entered, and the third remained pending while the second played. All three mobile scenes completed with no horizontal overflow. The existing 5 focused tests, changed-file Biome checks and production build/type validation passed. The in-app preview was refreshed and contains three chat scenes. Screenshots: `.local/design-qa/motion/group-chats-desktop-{before-entry,middle,complete,detail}.jpg`, and `group-chats-mobile-{first,second,third}.jpg`.

### Horizontal gallery follow-up (supersedes the three-column playback behavior)

- Native horizontal scroll snap now centers one conversation. Starts with the carpool in the middle; arrow buttons, keyboard arrow keys and horizontal gestures select another card. Side cards are complete static previews. Playback pauses during scrolling and restarts only after the selected card settles at the center; offscreen/hidden-tab and reduced-motion behavior remain supported.
- Production Chrome checks: desktop center distance 0px; mobile center distance within 0.4px after button/gesture selection. Verified birthday, carpool and swim selection, keyboard navigation, and end-button boundaries. Active replies progressed while every side-card reply stayed at opacity 1. Mobile document width remains 390px; cards use a consistent 294px layout width, with long confirmation text wrapping inside the card.
- Changed-file Biome checks, 5 focused tests (including centered-only playback/selection/visibility/reduced-motion), production build/type validation and diff checks passed. No new dependency. Both in-app preview tabs refreshed; viewport overrides reset.
- Evidence: `.local/design-qa/motion/gallery-desktop-overview.jpg`, `gallery-desktop-center-motion.jpg`, `gallery-mobile-swipe.jpg`, `gallery-mobile-first.jpg`. Desktop overview and mobile first-card captures use the final production build. Reduced motion was verified in the runnable lifecycle test; no OS settings were changed.

### Gallery visual focus refinement

Applied the user's supplied showcase reference: desktop center card expands to 420px, side cards scale to 80%, sit 48px lower and use 25% opacity. The track fades at both edges; desktop arrows sit beside the cards. Mobile retains 44px buttons below the gallery, with a narrower edge fade. Selection transitions remain inside the reduced-motion preference; no new playback logic or dependency.

Final production checks at 1440×1000 and 390×844: selected card center distance 0px, opacity 1; side cards opacity 0.25 with fully visible static reply content. Desktop arrow selection and mobile horizontal gesture both restarted only the centered chat. Mobile document width 390px, buttons 44×44px, no browser errors/warnings. Biome, 5 focused tests, build/type validation and diff checks passed. Preview tabs refreshed and temporary viewport reset. Evidence: `.local/design-qa/motion/gallery-focus-{before,desktop,mobile}.jpg`.

### Gallery switch interruption fix

The previous switch had three stages: native scroll, a 140ms debounce, then a 200ms focus transition with an abrupt reset of the incoming conversation. Focus now follows scroll position each animation frame, using untransformed layout offsets, batched reads and compositor-only transform/opacity writes. React updates only at the start/end of travel. Native scrollend settles playback immediately; browsers without it retain the debounce fallback. Incoming replies are prepared while the card is still faded, and remain paused until centered. Removed the delayed CSS transition; only the three gallery cards receive the compositor hint.

Production desktop evidence: keyboard switching started with incoming opacity 0.25 and replies at 0; during travel, incoming opacity reached 0.867/scale 0.964 while outgoing opacity was 0.383/scale 0.836, with scrolling still true. At rest, scrolling became false and center scroll offset was 484px. Mobile button/gesture switching settled at 0px center distance, page width 390px, then began its reply sequence. No console errors/warnings. Six focused tests, Biome, production build/type validation and diff checks passed. Preview tabs refreshed, viewport reset. Evidence: `.local/design-qa/motion/gallery-smooth-desktop-{moving,midway}.jpg`, `gallery-smooth-mobile.jpg`. These checks confirm continuous state handoff; frame-rate profiling and physical-device testing were not performed.

## October 7 — iPhone / iMessage gallery (VIL-428)

- Reused the existing generated transparent iPhone plate. Live HTML group headers and conversations overlay the screen; status bar, Dynamic Island, composer and home indicator remain in the plate. Native blue/gray bubble shapes and tails are scoped to this artifact.
- Added finite three-dot typing indicators before delayed incoming messages. Bubble/avatar arrival is coordinated with the indicator; existing center-only playback, settled-scroll activation, offscreen pause, cleanup and reduced-motion static fallback remain in HomeMotion. No new dependency.
- Desktop 1440×1000 and mobile 390×844 / 320×812 checked in Chrome. All three conversations fit their internal screen bounds (320px: tallest content 472px within 479px); page scroll width does not exceed viewport width. Image loaded on all three phones. Light and dark page themes inspected.
- Live center-selection check: after settling on example 2, its first typing bubble had opacity 0.761; typing bubbles in both neighboring phones were 0. Only the centered conversation animates. Native swipe/snap and arrow controls retained.
- Six focused tests passed, including finite typing timing, inactive completion, selection replay, visibility pause, reduced-motion cleanup and gallery interpolation. Biome, build/type validation and git diff --check passed.
- Evidence: `.local/design-qa/phone-gallery/{desktop-typing,desktop-complete,mobile-320,mobile-390}.png`.
- Observed server-side `MISSING_MESSAGE` warnings during page rendering and the local Vercel Speed Insights script log. These remain outside this gallery change; this pass does not claim a clean full-site runtime log.
- Local draft on `feat/vil-428-landing-redesign`; copy/design review still required before merge. Saved as a local branch checkpoint; no push or deployment.

### Crop and pacing follow-up

- Removed the chat thread's automatic top margin, which was pushing the conversation to the bottom of the full handset. Header and thread now meet with no flex-generated gap.
- Cropped the handset to approximately its upper three quarters using CSS and the unchanged full-proportion plate. The conversation sets a minimum content height on narrow screens so the last message is not clipped. At 1440px the visible phone is 583–591px high; at 390px it is 580px; at 320px it is 491–537px. No horizontal page overflow at these sizes, and all thread bounds fit the crop.
- Chat timing interval reduced from 1800 to 1200ms on desktop and 1600 to 1100ms on mobile. Existing message entrance duration and gallery slide motion remain unchanged.
- Verified center-only typing after selection at both desktop and 320px: inactive indicators had opacity 0, while the active indicator was visible. Six focused tests, Biome, production build/type validation and git diff --check passed.
- New evidence: `.local/design-qa/phone-gallery/{cropped-desktop,cropped-desktop-typing,cropped-mobile-320,cropped-mobile-390}.png`. Existing full-site runtime warning notes above still apply.

### Native dark iMessage follow-up

- Gallery phones now inherit the site color scheme. Dark uses a black screen, white message/status text, deep gray incoming/typing bubbles and matching black bubble-tail cutouts; light retains white screens and gray incoming bubbles. Confirmation chips use the existing themed amber and ink tokens.
- The realistic black handset plate is unchanged. Theme-aware CSS screen and live status-bar overlays cover its baked-in light interface, preserving the black body in both themes without image inversion or a second raster asset.
- Six focused tests, Biome and production build/type validation passed. Center-only typing was observed in dark mode; side indicators remained hidden. Screenshot evidence: `.local/design-qa/phone-gallery/dark-typing.png` and `dark-complete.png`.

### All handset previews follow the theme

- Audited site handset renderers: the homepage hero has one CSS phone, and the gallery has three plate-based phones. No additional handset preview is rendered by the subpage components.
- Hero and gallery now share the same native screen/ink/meta/incoming tokens. Hero status SVGs use currentColor; header, composer, bubble-tail masks and home indicator follow the theme. The hero handset body is black.
- Browser theme-toggle check: all four screens computed as rgb(0, 0, 0) in dark and rgb(255, 255, 255) in light. Hero status icons and home indicator were white in dark; incoming bubbles were rgb(38, 38, 40), with black tail cutouts. No desktop horizontal page overflow.
- Six focused tests, Biome, production build/type validation and git diff --check passed. Hero evidence: `.local/design-qa/phone-gallery/dark-hero.png`.

### All native message artifacts follow the theme

- Extended the shared native screen/ink/meta/incoming tokens to the annual-flow mini conversations, notification and reminder, the logistics memory conversation and message previews on `/text`, `/activities` and `/for-centres`. Removed their forced light color schemes. Confirmation chips use the themed amber/ink pair; reminder body/dividers/date header also follow the theme.
- Browser checks confirmed all four annual-flow preview containers have black backgrounds and white text in dark mode, with gray incoming bubbles. Both `/text` previews and the Activities/For centres conversation previews were also black. Existing phone styling and motion were preserved.
- Six focused tests, Biome, production build/type validation and git diff --check passed. Evidence: `.local/design-qa/phone-gallery/dark-year-previews.png`.


### October 7 legal and outward-copy review follow-up

- Requested scope: the legal conflicts and outward-copy conflicts identified against the Linear handoff. Local review draft; no clearance, new commit, push, merge or deployment.
- Privacy now distinguishes private family profiles/1:1 content from voluntary group messages, adds consent/recipient boundaries and a working group-chat TOC entry, and explains participants' retained copies. Optional feeds/naps remain disclosed because the app still has those collection paths. Privacy Officer is presented by role and email pending name confirmation.
- Terms now describe today's Free-only availability and require express agreement to future paid pricing/billing terms and separate approval for provider sign-ups. Privacy, Terms and For centres describe registration as a future paid capability.
- STOP wording removed from the English homepage and eight redesigned non-legal subpages. Exact opt-out instructions remain in both legal pages. FR/ZH marketing regeneration remains pending English clearance.
- Regression checks failed on the old copy, then passed after the changes: 6 test files / 62 tests. Changed-file Biome lint, production build/type validation and git diff --check passed.
- Final production-preview HTTP checks verified all nine marketing surfaces and both legal pages. Real Chrome verified the group-chat and planned-paid TOC links and rendered text, with no horizontal overflow at the normal desktop viewport. Evidence: `.local/design-qa/legal-copy/privacy-groups.png` and `terms-plans.png`.
- Proposed wording, government drafting references and outstanding Barton decisions are in `docs/landing-redesign-copy-review.md`. This pass edits copy; it does not implement or certify group isolation, consent enforcement or billing.

### October 7 — text greeting and guide detail follow-up

- English `/text` now displays the settled postal-code greeting by default, using the existing ladder copy key. Flagged Apple location sharing and the outgoing prefill/URI/source/QR/contact behaviors are retained. This is a preview-copy change, without changing backend rollout flags.
- All 15 English `/answers/[slug]` pages now use the October shared chrome, shore hero, reading panel, related cards and closing CTA. Corpus content, citations, review dates, metadata, JSON-LD and the review-before-index gate remain unchanged. FR/ZH retain their prior presentation pending English clearance.
- Six focused test files / 65 tests passed, including every guide's visible paragraphs, takeaways, FAQ content and source links, both CTA configurations, default/disabled/enabled greeting flags and shared chrome. Biome lint, production build/type validation and `git diff --check` passed.
- Real Chrome verified guide details in light/dark at desktop, and at 390px/320px widths. A long citation URL initially overflowed on mobile; scoped source wrapping resolved it, with document widths matching both viewports. `/text` was verified at 1440px/390px with the exact greeting and unchanged outgoing message. Theme and temporary viewport overrides were restored.
- Evidence: `.local/design-qa/guide-details/desktop-light.png`, `desktop-dark.png`, `mobile-light.png`, `text-greeting.png`. Follow-up is local and uncommitted on `feat/vil-428-landing-redesign`; no merge or deployment.
