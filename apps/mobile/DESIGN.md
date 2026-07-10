# Hale — Design north star ("Meadow")

Read this before building any screen. It is the durable intent; the code is the
expression. Mirrors the web's design system (`apps/web/app/globals.css`) so the
product reads as one thing across web and mobile.

## The one principle

**Calm is the product, so restraint is the design.** Hale is a passive assistant
for exhausted parents handling their most sensitive data (a newborn's). Every
instinct to "make it pop" works against that. The best version of a Hale screen
looks like it was barely designed — the content and the whitespace carry it.

> The test for any screen: *can a parent one-hand it at 3am, baby in the other
> arm, in the dark, half-asleep?* If a choice doesn't serve that person in that
> moment, cut it.

## Principles (in priority order)

1. **Content-first, chrome-light.** The village feed, the "right now," the child
   are the stars. Tab bars, headers, accents recede. If an element isn't the
   parent's content or their next action, make it quieter or delete it.
2. **One accent, used rarely.** Apricot is the single loud color — which is why
   it should almost never be a fill. Most screens are linen + ink + one or two
   subtle tones. When apricot appears it must *mean* something, not decorate.
   (We removed the big apricot circles — the Ask tab and the quick-log mic —
   because two competing fills + decoration broke the calm. Learn from it.)
3. **Trust through legibility, not polish.** For AI + kids' data, the highest-
   value design makes the *system legible*: what Hale did, what's waiting, what's
   redacted and why. The teen-redaction card ("Redacted · teen privacy ·
   category only") is the model — turn a privacy rule into visible reassurance.
4. **Consistency over novelty.** One language, shared tokens, the same patterns
   web↔mobile. A parent should never feel they switched products.
5. **Design for the 3am parent.** Large tap targets, dark mode as a real feature
   (night feeds), type readable at arm's length, reduced-motion respected,
   inputs with real labels + correct keyboards.
6. **Committed identity, not AI-default.** The biggest "AI made this" tell is the
   generic look (cream + serif + terracotta, hero-metric blocks, numbered
   eyebrows on every section). Meadow is a *specific* choice (Prussian +
   nursery-light). Keep making specific choices; never reach for the template.
7. **Motion: breathing, not bouncing.** Gentle, purposeful, fast (200–300ms),
   ease-out. No bounce, no elastic. Motion is the app exhaling, not performing.

## The system

**Palette (token roles; hex live in `global.css`, light / dark):**
- `canvas` warm off-white `#faf8f5` / charcoal-Prussian `#0c1420` — page background
- `card` white `#ffffff` / `#151e2c`; `raised` lifted surface
- `ink` Prussian `#0d1b3d` / cream — primary text; `ink-2` `#47587a` secondary;
  `ink-3` `#5b6b86` meta
- `accent` apricot-**deep** `#c2410c` — the **text-safe** accent (links, the one
  emphasis); `accent-fill` apricot `#f28c45` — **FILL / large-graphic only,
  never text or thin strokes, and used almost never**
- tones: `sage` (done), `berry` (needs-you), `sky` (coach), `sea` (brand/turtle)
  — each with a tint; tone meaning is carried by **label + shape, never color
  alone**

**Type:** Inter (display + body) + JetBrains Mono (numbers, dates, distances,
payloads). Display/title carry negative tracking (`-0.02em`). Web antialiasing
matched in the RN-web preview so type doesn't read heavier than `apps/web`.

**Radius:** card ladder 8 / 14 / 16 / 18; pill-full for tags + chips. Cards are
the lazy answer — use them only when they're the right affordance; never nest.

## Bans (refuse-and-rewrite)

- No big apricot-fill shapes as decoration (the orange-circle lesson).
- No emoji, ever. Product name is always "Hale".
- No color-only meaning (always label + shape too).
- No AI-default scaffolding: numbered section eyebrows by reflex, hero-metric
  blocks, gradient text, glassmorphism-by-default, side-stripe borders.
- No placeholder-only inputs; every input has a real label + correct keyboard.

## How we verify

Taste *plus* objective gates, never taste alone:
- **Gates** (every change): `tsc`, `expo export ios`, `expo-doctor 21/21`, lint.
- **Visual**: Expo-web preview screenshots (catches unstyled / layout bugs the
  compile-gates can't). Real-device truth = TestFlight.
- **Judgment**: review each screen against the 3am-parent scene above, and run
  the `impeccable` / `design-taste-frontend` skills for anti-slop + craft.

**One line:** make it disappear. The best Hale UI is the one the parent never has
to think about.
