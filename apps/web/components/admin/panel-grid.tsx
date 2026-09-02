import { Suspense } from 'react';
import { Panel, type PanelLink, PanelSkeleton } from './panel';
import { PanelBoundary } from './panel-boundary';
import { Reveal } from './reveal';

/**
 * The ledger grid every tab page mounts: each panel keeps the one anatomy —
 * Reveal → Panel (eyebrow + console links that render in EVERY state) →
 * PanelBoundary (named) → Suspense + skeleton. Server component; bodies are
 * async Server Components streamed per panel.
 */
export interface PanelSpec {
  eyebrow: string;
  links: PanelLink[];
  body: React.ReactNode;
  span2?: boolean;
}

export function PanelGrid({ panels }: { panels: PanelSpec[] }) {
  return (
    <div className="adm-grid">
      {panels.map((panel, index) => (
        <Reveal
          key={panel.eyebrow}
          index={index}
          className={panel.span2 ? 'adm-span2' : undefined}
        >
          <Panel eyebrow={panel.eyebrow} links={panel.links}>
            <PanelBoundary label={panel.eyebrow}>
              <Suspense fallback={<PanelSkeleton />}>{panel.body}</Suspense>
            </PanelBoundary>
          </Panel>
        </Reveal>
      ))}
    </div>
  );
}
