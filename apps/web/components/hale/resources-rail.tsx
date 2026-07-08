import { ExternalLink } from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import type { CuratedResourceView } from '~/lib/village/curated-resources';

/**
 * The Village "Resources" rail — a calm, directory-style list of hand-verified
 * public local programs (EarlyON centres, library programs, splash pads, public
 * health lines). Distinct from the AI-discovered candidate cards: these are
 * curated reference data, so the rail is quiet and outward-linking, not
 * actionable (no accept/endorse/share). Each row shows the name, a category chip,
 * the coarse service area, and an outbound link that opens in a new tab.
 *
 * Renders NOTHING when the list is empty (the seed hasn't run, or a preview with
 * no DB) — a directory with no entries is simply absent, never a hollow shell.
 */
export function ResourcesRail({ resources }: { resources: CuratedResourceView[] }) {
  if (resources.length === 0) return null;
  return (
    <section className="rise rise-5 mt-16 lg:mt-20">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
        <div className="lg:col-span-3">
          <span className="eyebrow">resources near you</span>
          <p className="meta mt-2 text-slate-green">
            verified public programs &amp; supports for families
          </p>
        </div>
        <div className="lg:col-span-9 divide-y divide-rule">
          {resources.map((resource) => (
            <ResourceRow key={resource.id} resource={resource} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ResourceRow({ resource }: { resource: CuratedResourceView }) {
  return (
    <a
      href={resource.url}
      target="_blank"
      rel="noreferrer"
      className="group flex items-start justify-between gap-4 py-5 first:pt-0"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="pill">{resource.category}</span>
          <span className="meta text-faded-sage">{resource.area}</span>
        </div>
        <p className="text-lg text-spruce leading-tight group-hover:text-apricot-deep">
          {resource.name}
        </p>
        <p className="meta text-slate-green">{resource.description}</p>
      </div>
      <Icon
        as={ExternalLink}
        size={18}
        className="mt-1 shrink-0 text-slate-green group-hover:text-apricot-deep"
      />
    </a>
  );
}
