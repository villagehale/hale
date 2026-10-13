import { readFile } from 'node:fs/promises';

/**
 * Node 22 rejects `import('./file.json')` unless the import carries
 * `with { type: 'json' }`. The census tables in place.ts are loaded that way,
 * which Next and Vitest accept. This hook is what lets `--estimate` read them
 * under plain `node`.
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const source = await readFile(new URL(url), 'utf8');
    return { format: 'json', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
