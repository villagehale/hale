/**
 * The static (non-interactive) per-child tag — the label half of the shared
 * scope treatment, for surfaces that show WHICH child something is about rather
 * than letting the parent pick (a plan card, an approval row). A `null` childId
 * reads "whole family"; otherwise the child's already-teen-safe label is shown —
 * a 13+ child's name is withheld upstream (rule #1), so `label: null` renders
 * "your teen". Only a real given name carries the PII marker; "whole family" is
 * not PII.
 */
export function ChildTag({ childId, label }: { childId: string | null; label: string | null }) {
  if (childId === null) {
    return <span className="pill">whole family</span>;
  }
  return (
    <span className="pill" data-hale-pii>
      {label ?? 'your teen'}
    </span>
  );
}
