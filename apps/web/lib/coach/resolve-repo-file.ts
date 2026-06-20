import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a monorepo-relative path (e.g. `apps/worker/prompts/coach.md`) at
 * runtime by walking UP from every plausible anchor and testing `<dir>/<rel>`.
 *
 * The previous resolver only checked two fixed locations and anchored on an
 * `apps/web` path segment — neither exists in a Vercel serverless bundle, so the
 * coach threw "could not locate …" in production while working locally. Walking
 * up from `process.cwd()` and this module's own directory finds the file wherever
 * the bundle places it, as long as it was shipped — which `next.config.ts`
 * guarantees via `outputFileTracingIncludes`. Single source of truth is still the
 * worker's file (rule #2); we never write a copy.
 */
export function resolveRepoFile(rel: string): string {
  const anchors = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const anchor of anchors) {
    let dir = anchor;
    const root = parse(dir).root;
    while (true) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  throw new Error(`resolveRepoFile: could not locate ${rel} from cwd=${process.cwd()}`);
}
