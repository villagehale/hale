import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../../web/lib/format/link-shape.ts');
const TSCONFIG = join(HERE, '../../../web/tsconfig.json');

let loaded;

/**
 * The product's hasLinkShape, loaded once per process. A grader that keeps its own
 * regex drifts, and a bare domain walks through the old http/www copy.
 *
 * An eval that already registered tsx (holding-line, so its `~/` imports resolve)
 * is left alone: another tsImport stacks a loader and those imports stop resolving.
 * An eval with no loader yet gets one, with the web tsconfig.
 */
export async function loadHasLinkShape() {
  if (!loaded) {
    loaded = await read();
  }
  return loaded;
}

async function read() {
  try {
    return (await import(pathToFileURL(SRC).href)).hasLinkShape;
  } catch (err) {
    if (!unknownExtension(err)) throw err;
    const mod = await tsImport(SRC, { parentURL: import.meta.url, tsconfig: TSCONFIG });
    return mod.hasLinkShape;
  }
}

function unknownExtension(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  // Node 22 can load .ts and then fail the extensionless './root-zone-tlds' import.
  return err.code === 'ERR_UNKNOWN_FILE_EXTENSION' || err.code === 'ERR_MODULE_NOT_FOUND';
}
