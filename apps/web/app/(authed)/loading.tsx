import { PageCorner } from '~/components/hale/page-corner';

/**
 * Suspense fallback for every authed page while its server data loads. It mirrors
 * the universal page frame — the desktop page corner and the `rise rise-1`
 * eyebrow + display-H1 header every page opens with — so the swap from skeleton
 * to real content is a fill in place, not a jump. That is the fix for nav feeling
 * buggy between screens: the boundary was here, but the placeholder didn't match
 * the page's shape, so each transition shifted. Bars settle to the page's own
 * surface and motion stops under prefers-reduced-motion (DESIGN.md §6).
 */
function SkeletonBar({ className }: { className?: string }) {
  return <div className={`skeleton-bar ${className ?? ''}`} />;
}

export default function AuthedLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <PageCorner folio="··" section="loading" />

      {/* The eyebrow + display-H1 header band every page opens with. Heights are
       * reserved to the real header's so nothing reflows when content lands. */}
      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3 space-y-3">
            <SkeletonBar className="h-3 w-24" />
            <SkeletonBar className="h-3 w-40" />
          </div>
          <div className="lg:col-span-9 space-y-4">
            <SkeletonBar className="h-12 lg:h-16 w-11/12" />
            <SkeletonBar className="h-12 lg:h-16 w-3/5" />
          </div>
        </div>
      </header>

      {/* A first body block, sized like a section, so the page below the fold has
       * weight too — keeps the skeleton from looking top-heavy then jumping. */}
      <section className="rise rise-2 space-y-5">
        <div className="panel-oat px-6 py-8 space-y-3">
          <SkeletonBar className="h-3 w-2/5" />
          <SkeletonBar className="h-6 w-11/12" />
          <SkeletonBar className="h-6 w-3/4" />
        </div>
        <div className="panel-oat px-6 py-8 space-y-3">
          <SkeletonBar className="h-3 w-1/3" />
          <SkeletonBar className="h-6 w-4/5" />
        </div>
      </section>
    </div>
  );
}
