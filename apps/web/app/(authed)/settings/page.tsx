import Link from 'next/link';
import { PageCorner } from '~/components/hale/page-corner';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { loadFamilyHeader, loadFamilyMembers } from '~/lib/dashboard/queries';

export default async function FamilyPage() {
  const [members, header] = await Promise.all([loadFamilyMembers(), loadFamilyHeader()]);

  return (
    <div>
      <PageCorner folio="family" section="family · your household" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your family</span>
            <p className="meta mt-2">your kids · your area · your co-parent</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              your <span className="text-apricot-deep">household.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── Parents ────────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-y border-rule py-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">the grown-ups</span>
            <p className="meta mt-2">you · and a co-parent, if you have one</p>
          </div>
          <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
            <div>
              <p className="meta">you</p>
              {members.primary ? (
                <>
                  <p className="font-display text-[1.5rem] mt-1">
                    {members.primary.name ?? members.primary.email}
                  </p>
                  <p className="meta mt-1">{members.primary.email}</p>
                </>
              ) : (
                <p className="font-display text-[1.5rem] mt-1">not set up yet</p>
              )}
            </div>
            <div>
              <p className="meta">co-parent</p>
              {members.coParent ? (
                <>
                  <p className="font-display text-[1.5rem] mt-1">
                    {members.coParent.name ?? members.coParent.email}
                  </p>
                  <p className="meta mt-1">{members.coParent.email}</p>
                </>
              ) : (
                <>
                  <p className="font-display text-[1.5rem] mt-1">no co-parent yet</p>
                  <p className="meta mt-1">
                    — invite them so you can share the load. Until they join, anything that
                    touches their data waits for your tap.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Kids ───────────────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your kids</span>
            <p className="meta mt-2">birthday sets the stage Hale tailors to</p>
          </div>
          <div className="lg:col-span-9">
            {header.children.length === 0 ? (
              <div>
                <p className="font-display text-[1.5rem]">no kids added yet</p>
                <p className="meta mt-1">
                  — add a child&rsquo;s birthday and Hale tailors every stage to them.
                </p>
                <Link href="/onboarding" className="btn-primary mt-4 inline-flex">
                  add your kid →
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
                {header.children.map((child) => (
                  <div key={child.id}>
                    <p className="font-display text-[1.5rem]">{child.name}</p>
                    <p className="meta mt-1">{child.stageLabel}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Appearance ─────────────────────────────────────────────────── */}
      <section className="rise rise-5 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-b border-rule pb-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">appearance</span>
            <p className="meta mt-2">light · dark · match your device</p>
          </div>
          <div className="lg:col-span-9 flex flex-wrap items-center gap-x-6 gap-y-4">
            <p className="text-spruce leading-relaxed max-w-md">
              Choose a theme, or let Hale follow your device. Dark mode is the brand&rsquo;s own
              Prussian night.
            </p>
            <ThemeToggle />
          </div>
        </div>
      </section>

      {/* ── Privacy ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 pt-2">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {[
            "your family's data stays in canada · pipeda",
            'teen content is private from parents by default',
            'nothing is shared with a third party unless you connect one',
          ].map((note) => (
            <span key={note} className="meta">
              {note}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
