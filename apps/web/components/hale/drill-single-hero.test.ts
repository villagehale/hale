import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DRILL_HEROES, ROOT_ROUTES } from './hero-map';

/**
 * Design handoff §3.2 single-hero contract: the app shell (layout → PageHero) owns
 * the ONE hero for every authed surface — a serif <h1> hero title + subtitle for a
 * tab root, a breadcrumb + back + drill title for a drilled-in page. No page, and no
 * component a page renders, may emit its own <h1>/<header> too: that produces two
 * stacked titles (the visible "duplicate hero" regression) and two <h1>s in the
 * accessibility tree.
 *
 * The earlier version only scanned each DRILL route's page.tsx, so a root route whose
 * hero lives in a nested component (/coach → CoachConversation → AskHaleThread) went
 * unguarded — exactly how a duplicate "Hale" <h1> shipped. This walks the component
 * graph of every authed route (root + drill). A file bundling several exports (a badge
 * next to an unrendered public hero) would over-match, so an <h1>/<header> only counts
 * when it sits in the entry page itself or in a top-level component that is actually
 * rendered (`<Name`) somewhere in that route's graph.
 */

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const authedRoot = join(webRoot, 'app', '(authed)');

/** Resolve a local import specifier to a source file, or null for externals. */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('~/')) base = join(webRoot, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec);
  else return null; // node/package import — outside our render graph
  for (const cand of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, 'index.tsx'),
    join(base, 'index.ts'),
  ]) {
    if (/\.tsx?$/.test(cand) && existsSync(cand)) return cand;
  }
  return null;
}

/** Every source file reachable from a route's page.tsx, entry first. */
function graphSources(route: string): { file: string; src: string; entry: boolean }[] {
  const entry = join(authedRoot, route.replace(/^\//, ''), 'page.tsx');
  const seen = new Set<string>();
  const out: { file: string; src: string; entry: boolean }[] = [];
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file) || file.includes('.test.')) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    // Strip comments so prose like "renders no <h1>" in a doc-comment can't trip the
    // markup scan — only real JSX <h1>/<header> markup should count.
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    out.push({ file, src, entry: file === entry });
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const dep = resolveLocal(m[1] ?? '', file);
      if (dep) stack.push(dep);
    }
  }
  return out;
}

/** The top-level component (`function X`/`const X =`, column 0) enclosing a line. */
function enclosingComponent(src: string, upToIndex: number): string | null {
  const before = src.slice(0, upToIndex);
  const decls = [
    ...before.matchAll(
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/gm,
    ),
  ];
  const last = decls.at(-1);
  return last ? (last[1] ?? last[2] ?? null) : null;
}

describe('the app shell owns the single hero — no authed surface emits its own (§3.2)', () => {
  for (const route of [...ROOT_ROUTES, ...Object.keys(DRILL_HEROES)]) {
    it(`${route} render graph emits no own <h1> or <header>`, () => {
      const graph = graphSources(route);
      const graphText = graph.map((g) => g.src).join('\n');
      const offenders: string[] = [];
      for (const { file, src, entry } of graph) {
        for (const m of src.matchAll(/<(h1|header)[\s>]/g)) {
          const owner = entry ? null : enclosingComponent(src, m.index ?? 0);
          // Entry page markup is always live; a nested component's heading only counts
          // when that component is actually rendered somewhere in this route's graph.
          if (entry || owner === null || graphText.includes(`<${owner}`)) {
            offenders.push(`${file.replace(`${webRoot}/`, '')} (<${m[1]}> in ${owner ?? 'page'})`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
