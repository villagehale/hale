import { DestructiveButton } from '~/components/hale/destructive-button';
import { Folio } from '~/components/hale/folio';
import { PageCorner } from '~/components/hale/page-corner';
import type { MemoryFactView } from '~/lib/dashboard/mappers';
import { loadMemoryFacts } from '~/lib/dashboard/queries';

const TYPE_PILL: Record<MemoryFactView['type'], string> = {
  preference: 'pill-apricot',
  routine: 'pill-sage',
  medical: 'pill-apricot',
  logistic: 'pill',
  relationship: 'pill-sage',
  voice: 'pill-sky',
};

const TYPE_GROUPS: Array<{ type: MemoryFactView['type']; label: string }> = [
  { type: 'preference', label: 'preferences' },
  { type: 'routine', label: 'routines' },
  { type: 'voice', label: 'voice' },
  { type: 'medical', label: 'medical' },
  { type: 'logistic', label: 'logistics' },
  { type: 'relationship', label: 'relationships' },
];

function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`confidence ${percent}%`}
        tabIndex={0}
        className="h-1 w-24 rounded-full"
        style={{ background: 'var(--color-rule)' }}
      >
        <div
          aria-hidden
          className="h-full rounded-full"
          style={{ width: `${percent}%`, background: 'var(--color-spruce)' }}
        />
      </div>
      <span className="meta tabular" aria-hidden>
        {percent}%
      </span>
    </div>
  );
}

export default async function MemoryPage() {
  const facts = await loadMemoryFacts();

  return (
    <div>
      <PageCorner folio="05" section="memory · the family graph" />

      <header className="rise rise-1 mb-12 lg:mb-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">memory garden</span>
            <p className="meta mt-2">every fact, named and sourced</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              what i <span className="text-apricot-deep">remember</span>
              <br />
              about your household.
            </h1>
          </div>
        </div>
      </header>

      {/* ── The promise ────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 lg:mb-20 panel">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-8">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">the promise</span>
          </div>
          <div className="lg:col-span-9 text-spruce text-lg leading-relaxed">
            <p>
              Every fact below comes from a specific signal I observed. You can edit any of them,
              mark any of them wrong, or delete any of them — and I will retrain my behavior around
              the change before the next digest.{' '}
              <em>This is the only consumer ai product that shows you what it remembers.</em>
            </p>
            <div className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <span className="meta">{facts.length} facts in memory</span>
              <span className="meta">canadian residency · per-key encryption</span>
            </div>
          </div>
        </div>
      </section>

      {facts.length === 0 ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            Hale is still learning about your family.
          </p>
          <p className="meta mt-4 text-slate-green">
            no facts yet — as I observe your household's signals, every fact I learn will appear
            here, named and sourced, for you to edit or forget.
          </p>
        </section>
      ) : (
        <>
          {/* ── Faceted index ──────────────────────────────────────────── */}
          <section className="rise rise-3 mb-12 border-y border-rule py-6">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-3">
              <span className="eyebrow">browse</span>
              <button type="button" className="btn-ghost" aria-current="true">
                all · {facts.length}
              </button>
              {TYPE_GROUPS.map((g) => {
                const count = facts.filter((f) => f.type === g.type).length;
                return (
                  <button key={g.type} type="button" className="btn-ghost">
                    {g.label} · {count}
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── Cards grid (no shadow — just paper-toned panels) ───────── */}
          <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-rule">
            {facts.map((fact, idx) => {
              const delay = `rise-${Math.min(idx + 3, 7)}`;
              return (
                <article
                  key={fact.id}
                  className={`rise ${delay} bg-linen p-6 lg:p-7 space-y-4 flex flex-col`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={`pill ${TYPE_PILL[fact.type]}`}>{fact.type}</span>
                    <Folio index={idx + 1} />
                  </div>

                  <h3 className="font-display text-[1.5rem] leading-tight">{fact.key}</h3>

                  <p className="text-spruce leading-relaxed flex-grow">{fact.value}</p>

                  <div className="border-l-2 border-rule-strong pl-4">
                    <span className="eyebrow text-spruce">source</span>
                    <p className="mt-1 meta italic">{fact.source}</p>
                  </div>

                  <div className="flex items-end justify-between gap-3 pt-2 border-t border-rule">
                    <div>
                      <p className="meta">confidence</p>
                      <div className="mt-1.5">
                        <ConfidenceBar value={fact.confidence} />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <button type="button" className="btn-ghost text-sm">
                        edit
                      </button>
                      <DestructiveButton
                        label="forget"
                        confirmLabel="tap again to forget"
                        className="btn-ghost text-sm"
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        </>
      )}

      {/* ── Your rights ────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your rights</span>
            <p className="meta mt-2">non-negotiable</p>
          </div>
          <div className="lg:col-span-9 text-slate-green leading-relaxed space-y-5">
            <p>
              Request a full export of everything you see on this page in machine-readable form.
              Delete everything in one tap. The family graph never leaves Canadian-region storage.
              Nothing here is shared with any third party, ever.
            </p>
            <div className="pt-2 flex flex-wrap items-center gap-x-6 gap-y-3">
              <button type="button" className="btn-secondary">
                export everything
              </button>
              <DestructiveButton
                label="delete everything"
                confirmLabel="tap again to delete everything"
                className="btn-ghost"
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
