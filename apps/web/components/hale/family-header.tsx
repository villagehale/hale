import { loadFamilyHeader } from '~/lib/dashboard/queries';

/**
 * The family band shown across authed pages: each child with their current
 * derived stage, and the union of stages the experience tailors to. Renders
 * nothing when there are no children yet (dev preview / onboarding incomplete) —
 * the page's own empty state carries the message there.
 */
export async function FamilyHeader() {
  const { children, stages } = await loadFamilyHeader();
  if (children.length === 0) return null;

  return (
    <section className="family-band" aria-label="your family">
      <ul className="family-band-children">
        {children.map((child) => (
          <li key={child.id} className="family-band-child" data-hale-pii>
            <span className="font-display text-[1.15rem] leading-none">{child.name}</span>
            <span className="stamp">{child.stageLabel}</span>
          </li>
        ))}
      </ul>
      <p className="meta">tailored to {stages.join(' + ')}</p>
    </section>
  );
}
