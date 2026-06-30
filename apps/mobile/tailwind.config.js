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
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: { sm: "8px", md: "14px", lg: "16px", xl: "18px" },
      letterSpacing: { display: "-0.02em", eyebrow: "0.12em" },
    },
  },
  plugins: [],
};
