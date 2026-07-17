/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  // dark mode follows the device (matches @media prefers-color-scheme in global.css)
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        canvas: "var(--color-canvas)",
        card: "var(--color-card)",
        raised: "var(--color-raised)",
        chrome: "var(--color-chrome)",
        ink: {
          DEFAULT: "var(--color-ink)",
          2: "var(--color-ink-2)",
          3: "var(--color-ink-3)",
        },
        "on-ink": "var(--color-on-ink)", // label on an ink fill — white (light) / Prussian (dark)
        accent: {
          DEFAULT: "var(--color-accent)", // text-safe (apricot-deep)
          fill: "var(--color-accent-fill)", // FILL ONLY (apricot)
          tint: "var(--color-accent-tint)",
        },
        sea: "var(--color-sea)",
        sage: { DEFAULT: "var(--color-sage)", tint: "var(--color-sage-tint)" },
        berry: { DEFAULT: "var(--color-berry)", tint: "var(--color-berry-tint)" },
        sky: { DEFAULT: "var(--color-sky)", tint: "var(--color-sky-tint)" },
        rule: {
          DEFAULT: "var(--color-rule)",
          strong: "var(--color-rule-strong)",
        },
        // handoff primary navy — distinct from ink text (buttons, active nav, user
        // bubbles, selected-chip borders). See global.css --color-brand.
        brand: "var(--color-brand)",
        // handoff hairline / border aliases (card-border == rule, input-border ==
        // rule-strong; named here so the handoff class names resolve too)
        hairline: "var(--color-hairline)",
        "card-border": "var(--color-card-border)",
        "input-border": "var(--color-input-border)",
        // handoff extended text + status tones
        caption: "var(--color-caption)",
        success: "var(--color-success)",
        badge: "var(--color-badge)",
        destructive: "var(--color-destructive)",
        // handoff cream highlight card
        cream: {
          DEFAULT: "var(--color-cream)",
          border: "var(--color-cream-border)",
          accent: "var(--color-cream-accent)",
        },
        // handoff tint chips — six icon-chip backgrounds + their icon colors
        chip: {
          blue: "var(--color-chip-blue)",
          "blue-icon": "var(--color-chip-blue-icon)",
          green: "var(--color-chip-green)",
          "green-icon": "var(--color-chip-green-icon)",
          yellow: "var(--color-chip-yellow)",
          "yellow-icon": "var(--color-chip-yellow-icon)",
          red: "var(--color-chip-red)",
          "red-icon": "var(--color-chip-red-icon)",
          teal: "var(--color-chip-teal)",
          "teal-icon": "var(--color-chip-teal-icon)",
          gray: "var(--color-chip-gray)",
          "gray-icon": "var(--color-chip-gray-icon)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: { sm: "10px", md: "16px", lg: "24px", xl: "28px" },
      letterSpacing: { display: "-0.02em", eyebrow: "0.12em" },
    },
  },
  plugins: [],
};
