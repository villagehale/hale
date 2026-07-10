'use client';

/**
 * A thin two-option (or more) segmented control with TEXT labels, mirroring
 * ThemeToggle's markup and tokens (the .theme-toggle fieldset + pill options).
 * Used by the Preferences card for Units and First-day-of-week. Purely
 * controlled: the parent holds the value and is told which option was chosen.
 */
export function PreferenceToggle({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset aria-label={legend} className="theme-toggle">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="theme-toggle-option theme-toggle-option--text"
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
