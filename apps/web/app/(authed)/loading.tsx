/**
 * Suspense fallback for every authed page while its server data loads. Renders a
 * calm skeleton in the same editorial rhythm as the real pages rather than a
 * spinner — the header band stays, the body settles into placeholder lines.
 */
function SkeletonLine({ className }: { className?: string }) {
  return <div className={`h-4 rounded bg-rule animate-pulse ${className ?? ''}`} />;
}

export default function AuthedLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">loading</span>
            <SkeletonLine className="mt-3 w-3/4" />
          </div>
          <div className="lg:col-span-9 space-y-4">
            <SkeletonLine className="h-10 w-11/12" />
            <SkeletonLine className="h-10 w-3/5" />
          </div>
        </div>
      </header>

      <section className="rise rise-2 grid grid-cols-1 md:grid-cols-2 gap-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel-oat px-6 py-8 space-y-3">
            <SkeletonLine className="w-2/5" />
            <SkeletonLine className="h-6 w-11/12" />
            <SkeletonLine className="w-3/4" />
          </div>
        ))}
      </section>
    </div>
  );
}
