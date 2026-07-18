# Hale — Design north star ("Hale Shore")

Read this before building any screen. It is the durable intent; the code is the
expression. Hale Shore is the design-handoff system — a deep Hale navy on a
warm-white canvas, with scarce warm cream and apricot — applied verbatim from the
interactive prototype and mirrored with `apps/web` so the product reads as one
thing across web and mobile.

> Migration note: the token layer was carried over from the prior "Meadow" system,
> so some code identifiers still say Meadow (`src/constants/meadow.ts`,
> `useMeadowColor`). That rename is deferred housekeeping — the palette itself is
> Hale Shore, defined in `src/global.css`.

## The one principle

**Calm is the product, so restraint is the design.** Hale is a passive assistant
for tired parents handling their most sensitive data (a newborn's). Every instinct
to "make it pop" works against that. The best version of a Hale screen looks like
it was barely designed — the content and the whitespace carry it.

> The test for any screen: *can a parent one-hand it at 3am, baby in the other
> arm, in the dark, half-asleep?* If a choice doesn't serve that person in that
> moment, cut it.

## Principles (in priority order)

1. **Content-first, chrome-light.** The village feed, the "right now," the child
   are the stars. Tab bars, headers, accents recede. If an element isn't the
   parent's content or their next action, make it quieter or delete it.
2. **One primary, used with intent.** Hale navy (`brand`) is the single
   committed color — active nav, the primary button, the user's chat bubble, a
   selected chip's border. Apricot (`accent`) is the rare second emphasis, and its
   fill form is large-graphic only. Most screens are warm-white + ink + one or two
   subtle tones. Cream highlight cards are deliberate, not decorative wallpaper.
3. **Trust through legibility, not polish.** For AI + kids' data, the highest-value
   design makes the *system legible*: what Hale did, what's waiting, what's redacted
   and why. The teen-redaction card ("Redacted · teen privacy · category only") is
   the model — turn a privacy rule into visible reassurance.
4. **Consistency over novelty.** One language, shared tokens, the same patterns
   web↔mobile. A parent should never feel they switched products.
5. **Design for the 3am parent.** Large tap targets, dark mode as a real feature
   (night feeds), type readable at arm's length, reduced-motion respected, inputs
   with real labels + correct keyboards.
6. **Committed identity, not AI-default.** Hale Shore is a *specific* choice
   (Hale navy + warm white + scarce cream/apricot + Source Serif display). Its
   cream cards and serif greetings are intentional, drawn from the prototype — not
   the generic "cream + serif + terracotta" reflex. Keep making specific choices;
   never sprinkle a treatment because it "looks designed."
7. **Motion: breathing, not bouncing.** Gentle, purposeful, fast (200–300ms),
   ease-out. No bounce, no elastic. Motion is the app exhaling, not performing.

## The system

Tokens live in `src/global.css` (`:root` light + `@media (prefers-color-scheme:
dark)`), are mapped to Tailwind class names in `tailwind.config.js`, and are
drift-checked against the literal-color mirror in `src/constants/meadow.ts` by
`scripts/check-token-drift.mjs`. Use the class names; never inline a hex.

### Palette (token role — light / dark — usage)

**Surfaces**
- `canvas` `#fdfcfa` / `#14120e` — page background (warm white / warm-dark near-black)
- `card` `#ffffff` / `#1e1b15` — card surface
- `raised` `#ffffff` / `#282318` — a lifted surface (one notch above card on dark)
- `chrome` (dark only) `#1b2160` — app frame

**Brand / primary**
- `brand` `#1b2160` / `#9aa6e6` — primary actions, active nav tint, user chat
  bubbles, selected-chip borders. White label on brand is 14.7:1 (light). On dark
  the navy **lightens** to `#9aa6e6` so it still reads as the accent against a dark
  canvas, and `on-ink` inverts to ink text (`#17294a`).
- `on-ink` `#ffffff` / `#17294a` — the label on an ink/brand fill

**Ink text** (contrast on canvas, light)
- `ink` `#17294a` / `#f6f1e7` — primary text (14.1:1)
- `ink-2` `#3d4c68` / `#c7d3e6` — body / secondary (8.4:1)
- `ink-3` `#5c6b87` / `#9bb0d0` — muted / meta (5.2:1) — the AA floor for small text
- `caption` `#8b95a9` / `#8b93a1` — caption gray (**2.9:1** — decorative/redundant
  subtext only; see the contrast policy below)

**Accent — apricot, scarce on purpose**
- `accent` `#c2410c` / `#fb923c` — the **text-safe** accent (links, one emphasis) (5.0:1)
- `accent-fill` `#f28c45` / `#f97316` — **FILL / large-graphic only**, never text or
  thin strokes, used rarely
- `accent-tint` `#fdeede` / `#2f2318`

**Secondary tones** (semantic; meaning carried by label + shape, never color alone)
- `sea` `#0a3d62` / `#6fb3c9` — turtle / brand accent
- `sage` `#4a5a3c` / `#a9c49a` (+ `sage-tint`) — done / handled
- `berry` `#9c3b54` / `#e09aaa` (+ `berry-tint`) — needs-you
- `sky` `#2a6478` / `#8fc1d1` (+ `sky-tint`) — coach

**Borders / hairlines**
- `rule` (= `card-border`) `#e4e7ee` — card border
- `rule-strong` (= `input-border`) `#d9dee8` — input / stronger border
- `hairline` `#f0f2f6` — list-row divider (omitted on the last row)

**Status**
- `success` `#2ea35e` / `#57c98a` · `badge` `#e8853d` / `#ef9350` (orange count
  badge) · `destructive` `#c2543f` / `#e59484`

**Cream highlight card** (embraced by this system — the prototype's "great news"
tile)
- `cream` `#fff6e9` / `#2a2114` · `cream-border` `#f5e5c9` / `#3c3020` ·
  `cream-accent` `#b26b1f` / `#e0b877` (accent text on cream)

**Tint chips** — six icon-chip tone pairs (chip background + its icon color), for
the handoff's 34×34 rounded icon chips. Meaning is the icon + label, never the tone.
- blue `#edf0fa` / icon `#3b5bdb` · green `#e7f6ec` / `#1f8a4c` · yellow `#fef0c7` /
  `#b26b1f` · red `#fdebe8` / `#c2543f` · teal `#e0f2f1` / `#0f766e` · gray
  `#f0f2f6` / `#5c6b87`. Dark variants deepen the background and lighten the icon.

### Type

Two families, paired:
- **Source Serif 4** — display and title only: greetings, page h1s, the child-name
  header, card confirmations. `display` = 600 (34 / 40, tracking `-0.02em`),
  `title` = 500 (22 / 28).
- **Instrument Sans** — everything else: `section` 600 (15 / 20), `body` 400 (14 / 21),
  `meta` 500 (13 / 18), `eyebrow` 700, and 700 for detail-header titles.
- Numbers, dates, and payloads render in Instrument Sans too — the prior JetBrains
  Mono "mono" role is retired (the `mono` variant maps to Instrument Sans).
- The **eyebrow / section label** is a first-class `eyebrow` variant (AppText),
  prototype-exact: **11.5px / 700 / uppercase / `tracking-eyebrow-tight` (0.07em) /
  caption gray** — not a numbered section header. Use `variant="eyebrow"`; never
  re-roll the old `meta + uppercase + tracking-eyebrow + ink-3` idiom. The 0.12em
  `tracking-eyebrow` token stays, but only for tag / chip / timing small-caps.

Source of truth for type is `components/ui/app-text.tsx` (`VARIANT_FAMILY`) plus the
`useFonts` load in `app/_layout.tsx`; on native, text sets `fontFamily` directly, so
the `--font-*` CSS vars and Tailwind `fontFamily` (still named Inter / JetBrains) are
residual and don't render.

### Radius

Tailwind ladder: `sm` 10 · `md` 16 · `lg` 24 · `xl` 28. In use: cards 20px, primary
button 16 (`md`), bottom-sheet top corners 28 (`xl`), inputs / small tiles 12–16,
icon chips ~11, pills + chips fully rounded. Cards are the lazy answer — use them
only when a card is the right affordance; never nest them.

### Iconography

Lucide outline set (`lucide-react-native`) via `components/ui/icon.tsx`, **1.8px
stroke**, default size 20 (15–21 in practice), color passed explicitly through the
`color` prop. Only names in the curated `ICONS` map exist — add a glyph there, don't
import ad hoc. Note the Village tab intentionally maps to `building-2` (a cluster of
homes), not a folded map.

### Emoji

Allowed **exactly where the prototype uses them** and nowhere else: the greeting
wave (👋), the pronunciation speaker (🔊), the location marker (📍). They stay small,
human, and always **redundant** to a text label or a Lucide glyph beside them — an
emoji is never the sole carrier of meaning, and the wordmark is always plain "Hale".
This is a short allow-list, not a decorative free-for-all.

### Dark theme

The dark palette is **derived**, not a separate design. Surfaces go warm-dark
(near-black `#14120e` canvas, cards one/two notches up), ink inverts to cream, and
the navy brand **lightens to `#9aa6e6`** so it still reads as the primary accent
against dark (with `on-ink` inverting to ink `#17294a`). Tones, cream, and tint chips each
get a hand-tuned dark pair — deepened backgrounds, lightened icons/text — kept in the
same `global.css` block and drift-checked. Dark mode follows the device
(`prefers-color-scheme` / Tailwind `darkMode: "media"`); it is a real feature for
night feeds, not an afterthought.

## Contrast & accessibility policy

**Essential text always earns a legible tone; verbatim fidelity is the default only
when it costs the reader nothing.**

The handoff's caption gray `#8B95A9` measures **2.9:1** on the `#FDFCFA` canvas —
below the WCAG AA floor of 4.5:1 for small text. So:

- **Fidelity wins by default.** Caption gray is the prototype's subtext color;
  matching it keeps prototype ↔ web ↔ mobile one thing. Use it freely for
  **redundant or decorative subtext** — a label already stated elsewhere, a soft
  timestamp beside a bold value, ornamental helper copy. The test: if deleting the
  caption would cost the reader no information, caption gray is fine.
- **Section-label eyebrows pass this test.** The `eyebrow` variant renders in caption
  gray by design: an eyebrow is a non-essential wayfinding label — the content
  beneath it carries the meaning, so deleting it costs the reader nothing. Caption
  gray on eyebrows is therefore policy-compliant, and it matches the prototype exactly.
- **Essential small text is never caption-only.** Any value a user must read — a
  count, a due date, a status, a measurement, an error or validation message, a
  state a decision depends on — renders in `ink-3` `#5C6B87` (5.2:1) or stronger,
  never in caption gray. If removing it would leave the user missing something,
  it is essential.

This is the small-text corollary of *color is never the sole carrier of meaning*:
contrast is never the sole gate on essential information either.

Also binding: color and emoji are never the sole carrier of meaning (pair with a
label + shape); every input has a real label and the correct keyboard; tap targets
stay large; reduced-motion is respected.

## Bans (refuse-and-rewrite)

- **No essential small text in caption gray** (`#8B95A9`) — see the contrast policy.
- No color-only or emoji-only meaning (always a label + shape too).
- No apricot-fill on text or thin strokes; `accent-fill` is large-graphic only and
  rare. Navy is the identity; apricot is the scarce emphasis.
- No placeholder-only inputs; every input has a real label + correct keyboard.
- No AI-default scaffolding by reflex: numbered section eyebrows on every section,
  hero-metric blocks, gradient text, glassmorphism-by-default, side-stripe borders.
  (Cream highlight cards and serif greetings are committed identity here — used
  deliberately per the prototype, not sprinkled to look designed.)
- No inline hexes — use the token class names so drift-check and dark mode hold.

## How we verify

Taste *plus* objective gates, never taste alone:
- **Gates** (every change): `tsc`, `expo export ios`, `expo-doctor`, lint, and the
  token drift-check (`pnpm --filter @hale/mobile check-tokens`).
- **Visual**: Expo-web preview screenshots (catches unstyled / layout bugs the
  compile-gates can't). Real-device truth = TestFlight.
- **Judgment**: review each screen against the 3am-parent scene above, and run the
  `impeccable` / `design-taste-frontend` skills for anti-slop + craft.

**One line:** make it disappear. The best Hale UI is the one the parent never has to
think about.
