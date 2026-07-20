import type { Route } from 'next';

/**
 * The single source of truth for the desktop top-bar hero (design handoff §3.2):
 * a tab root shows an <h1> hero title + subtitle; a drilled-in page shows a
 * breadcrumb + back button + a drill title. Both the desktop top bar and the
 * narrow-viewport hero read from here so the two can never disagree.
 *
 * The ROOT heroes carry interpolated copy (the home greeting, the companion
 * child's name) so they are built server-side and passed in as `roots`; the DRILL
 * heroes are static route → {crumb, title, backHref} and live here.
 */

export interface RootHero {
  title: string;
  subtitle: string;
  /** A decorative trailing glyph (e.g. the home greeting's wave), rendered
   * aria-hidden so it is never announced as content. */
  emoji?: string;
}

export interface DrillHero {
  /** The parent tab this page drilled in from (breadcrumb eyebrow). */
  crumb: string;
  /** The drill page's own title (serif). */
  title: string;
  /** Where the back button returns to. */
  backHref: Route;
}

export type HeroResolution =
  | { kind: 'root'; hero: RootHero }
  | { kind: 'drill'; hero: DrillHero };

/** The tab-root routes, in nav order. A root's hero copy is provided by the
 * server (see buildRootHeroes) because some of it is interpolated. */
export const ROOT_ROUTES = [
  '/home',
  '/companion',
  '/coach',
  '/village',
  '/family',
  '/settings',
] as const;

export type RootRoute = (typeof ROOT_ROUTES)[number];

/**
 * Drill-in pages that render under a breadcrumb + back (design handoff §3.2). These
 * are real sibling routes in this App Router build (the prototype's stack is real
 * navigation here), so each maps to the tab it belongs under.
 */
export const DRILL_HEROES: Record<string, DrillHero> = {
  '/approvals': { crumb: 'Family', title: 'Approvals', backHref: '/family' },
  '/messages': { crumb: 'Family', title: 'Messages', backHref: '/family' },
  // This repo's /plan is the week-ahead activity plan (not subscription/billing —
  // billing lives under /settings), so the drill title reflects the real content.
  '/plan': { crumb: 'Family', title: 'Plan', backHref: '/family' },
  '/saved': { crumb: 'Family', title: 'Saved', backHref: '/family' },
  '/trail': { crumb: 'Family', title: 'History', backHref: '/family' },
  '/family/members': { crumb: 'Family', title: 'Family & children', backHref: '/family' },
  '/companion/logs': { crumb: 'Companion', title: 'Logs', backHref: '/companion' },
};

/**
 * Resolve the hero for a pathname: a drill match wins (so /companion/logs reads as
 * a drill, not the /companion root), otherwise the longest matching root prefix.
 * Returns null when the path is outside the app surfaces (no hero shown).
 */
export function resolveHero(
  pathname: string | null,
  roots: Record<string, RootHero>,
): HeroResolution | null {
  if (!pathname) return null;
  const drill = DRILL_HEROES[pathname];
  if (drill) return { kind: 'drill', hero: drill };
  const root = ROOT_ROUTES.find((r) => pathname === r || pathname.startsWith(`${r}/`));
  if (root && roots[root]) return { kind: 'root', hero: roots[root] };
  return null;
}

/**
 * Build the root heroes map from the request's live values: the time-of-day
 * greeting (already warmed with the viewer's name) and the companion child's name
 * when the family has exactly one child (otherwise a family-wide subtitle — never a
 * fabricated single name, rule #1).
 */
export function buildRootHeroes(params: {
  greeting: string;
  childName: string | null;
}): Record<RootRoute, RootHero> {
  const companionSubtitle = params.childName
    ? `Everything about ${params.childName}, all in one place.`
    : 'Everything about your family, all in one place.';
  return {
    '/home': {
      title: params.greeting,
      subtitle: "Here's what's happening today.",
      emoji: '👋',
    },
    '/companion': { title: 'Companion', subtitle: companionSubtitle },
    '/coach': {
      title: 'Hale',
      subtitle: 'Your AI parenting partner — always with your approval.',
    },
    '/village': {
      title: 'Village',
      subtitle: 'Find local support, activities, care and resources for your family.',
    },
    '/family': { title: 'Family', subtitle: 'Manage your family, inbox, plan and account.' },
    '/settings': {
      title: 'Settings',
      subtitle: 'Your account, family, plan and preferences — all in one place.',
    },
  };
}
