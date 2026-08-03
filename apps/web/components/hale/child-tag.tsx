import { childTone } from '~/components/hale/child-tone';

/**
 * The static (non-interactive) per-child tag — the label half of the shared
 * scope treatment, for surfaces that show WHICH child something is about rather
 * than letting the parent pick (a plan card, an approval row). A `null` childId
 * reads "whole family"; otherwise the child's already-teen-safe label is shown —
 * a 13+ child's name is withheld upstream (rule #1), so `label: null` renders
 * "your teen". Only a real given name carries the PII marker; "whole family" is
 * not PII.
 *
 * VIL-209 W3: the tag is grounded in the child's stable tint (see child-tone.ts)
 * so per-kid lanes are scannable. `tone` lets a caller that knows the scope is
 * NOT one child — a shared outing, the whole family — ask for the neutral gray
 * without inventing a child id to hash.
 */
export function ChildTag({
  childId,
  label,
  tone = childTone(childId),
}: {
  childId: string | null;
  label: string | null;
  tone?: ReturnType<typeof childTone>;
}) {
  if (childId === null) {
    return <span className={`pill pill-tint chip-${tone}`}>whole family</span>;
  }
  return (
    <span className={`pill pill-tint chip-${tone}`} data-hale-pii>
      {label ?? 'your teen'}
    </span>
  );
}
