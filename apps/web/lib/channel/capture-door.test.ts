import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every outbound Linq call goes through outbound-transport.ts, so the Preview
 * capture switch and its refusals (preview only, no Linq key, no Linq line)
 * cover every send, in production too.
 *
 * one-door.test.ts asks "is this send ledgered?". This test asks "can this send
 * skip the capture switch?". It is an allowlist: outside outbound-transport.ts and
 * linq/transport.ts, any value import, re-export, require or dynamic import of
 * linq/transport (any quote style, `.js`/`.ts`/`index` suffix, `~/` or relative
 * path) fails unless every name it takes is a read-only export below. Namespace,
 * default, `export *` and bare imports fail outright. Type-only imports pass.
 * Any `linqapp.com` in a string, template or code outside linq/transport.ts fails
 * (doc links in comments are fine).
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const LINQ_TRANSPORT = 'apps/web/lib/channel/linq/transport.ts';
const DOOR = 'apps/web/lib/channel/outbound-transport.ts';
const ALLOWED = new Set([DOOR, LINQ_TRANSPORT]);

/**
 * linq/transport exports that never reach a parent's chat or Hale's line:
 * constants, the error class, payload readers and GET-only reads. A new export
 * is a send until it is added here on purpose.
 */
const READ_ONLY_EXPORTS = new Set([
  'SEND_TIMEOUT_MS',
  'LinqSendError',
  'linqMessageKey',
  'LINQ_TAPBACKS',
  'readLinqMessageId',
  'readLinqChatId',
  'readLinqCreatedMessageId',
  'readLinqPollEnvelope',
  'readLinqChatHandles',
  'contactCardIsLive',
  'LINQ_SCREEN_EFFECTS',
  'LINQ_BUBBLE_EFFECTS',
  'isLinqMessageEffect',
  'readListedDirectChatId',
  'LINQ_MALFORMED_CHAT_PAGE',
  'readLinqChatPage',
  'localityFromLocationPayload',
  'listLinqWebhookSubscriptions',
  'listLinqChatsPage',
  'listLinqParticipantHandles',
  'retrieveLinqContactCard',
  'retrieveLinqLocation',
]);

const SCAN_ROOTS = [
  'apps/web/app',
  'apps/web/lib',
  'apps/web/components',
  'apps/web/scripts',
  'apps/worker/src',
  'apps/worker/scripts',
  'packages',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

const TRANSPORT_STEM = 'apps/web/lib/channel/linq/transport';

function pointsAtLinqTransport(file: string, specifier: string): boolean {
  let target: string;
  if (specifier.startsWith('~/')) target = `apps/web/${specifier.slice(2)}`;
  else if (specifier.startsWith('.'))
    target = relative(REPO_ROOT, resolve(dirname(file), specifier));
  else return false;
  target = target.replace(/\.(ts|tsx|js|mjs)$/, '').replace(/\/index$/, '');
  return target === TRANSPORT_STEM;
}

type Finding = { file: string; why: string };

const Q = `(?:'|"|\`)`;
const SPEC = `${Q}([^'"\`]+)${Q}`;
/** `import … from 'x'` and `export … from 'x'`, any quotes, multi-line clauses. */
const FROM_CLAUSE = new RegExp(`\\b(import|export)\\s+(type\\s+)?([^;]*?)\\s*from\\s*${SPEC}`, 'g');
/** `import 'x'` (side-effect only). */
const BARE_IMPORT = new RegExp(`\\bimport\\s*${SPEC}`, 'g');
/** `require('x')` and `import('x')`. */
const CALL = new RegExp(`\\b(require|import)\\s*\\(\\s*${SPEC}\\s*\\)`, 'g');

function namesOf(clause: string): string[] | null {
  const braces = clause.match(/^\{([\s\S]*)\}$/);
  if (!braces) return null; // namespace, default, `*`, or mixed default + braces
  return (braces[1] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n && !n.startsWith('type '))
    .map((n) => n.split(/\s+as\s+/)[0]?.trim() ?? '');
}

/** Findings for one source file; the negative control feeds it fixtures. */
function scanSource(
  file: string,
  rel: string,
  text: string,
): { findings: Finding[]; imports: boolean } {
  const findings: Finding[] = [];
  let imports = false;
  // Doc links in block or whole-line comments are not a host; any string,
  // template or code that names it is.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (rel !== LINQ_TRANSPORT && /linqapp\.com/i.test(code)) {
    findings.push({ file: rel, why: 'names linqapp.com' });
  }
  const outside = !ALLOWED.has(rel);
  for (const m of text.matchAll(FROM_CLAUSE)) {
    const [, kind, typeOnly, rawClause = '', specifier = ''] = m;
    if (!pointsAtLinqTransport(file, specifier)) continue;
    imports = true;
    if (!outside || typeOnly) continue;
    const names = namesOf(rawClause.trim());
    if (names === null) {
      findings.push({ file: rel, why: `${kind} of linq/transport that is not a named list` });
      continue;
    }
    for (const name of names) {
      if (!READ_ONLY_EXPORTS.has(name)) findings.push({ file: rel, why: `${kind}s ${name}` });
    }
  }
  for (const m of text.matchAll(BARE_IMPORT)) {
    if (pointsAtLinqTransport(file, m[1] ?? '')) {
      imports = true;
      if (outside) findings.push({ file: rel, why: 'bare import of linq/transport' });
    }
  }
  for (const m of text.matchAll(CALL)) {
    if (pointsAtLinqTransport(file, m[2] ?? '')) {
      imports = true;
      if (outside) findings.push({ file: rel, why: `${m[1]}() of linq/transport` });
    }
  }
  return { findings, imports };
}

function scan(): { findings: Finding[]; importers: string[] } {
  const findings: Finding[] = [];
  const importers: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const rel = file.slice(REPO_ROOT.length + 1);
      const result = scanSource(file, rel, readFileSync(file, 'utf8'));
      findings.push(...result.findings);
      if (result.imports) importers.push(rel);
    }
  }
  return { findings, importers };
}

/** A module that skips the door every way the old denylist scanner missed. */
const NEGATIVE_FIXTURE_REL = 'apps/web/lib/channel/linq/bypass.fixture.ts';
const NEGATIVE_FIXTURE = [
  `import { sendLinqChatMessage } from '~/lib/channel/linq/transport';`,
  `import { createLinqChat } from "./transport";`,
  `import {\n  LinqSendError,\n  addLinqParticipant as add,\n} from './transport.js';`,
  `export { sendLinqParts } from '~/lib/channel/linq/transport/index';`,
  `export * from './transport';`,
  `import * as linq from "./transport";`,
  `const t = require('./transport');`,
  'const d = await import(`~/lib/channel/linq/transport.ts`);',
  'const host = "linqapp.com"; const url = `https://api.${host}/v3`;',
  "const base = 'https://api.linqapp.com';",
].join('\n');

describe('every Linq send goes through outbound-transport (capture covers it)', () => {
  const { findings, importers } = scan();

  it('positive control: the scanner sees the door importing linq/transport', () => {
    expect(importers).toContain(DOOR);
  });

  it('negative control: the scanner flags every bypass in the fixture', () => {
    const file = join(REPO_ROOT, NEGATIVE_FIXTURE_REL);
    const { findings: hits, imports } = scanSource(file, NEGATIVE_FIXTURE_REL, NEGATIVE_FIXTURE);
    expect(imports).toBe(true);
    expect(hits.map((h) => h.why).sort()).toEqual(
      [
        'imports sendLinqChatMessage',
        'imports createLinqChat',
        'imports addLinqParticipant',
        'exports sendLinqParts',
        'export of linq/transport that is not a named list',
        'import of linq/transport that is not a named list',
        'require() of linq/transport',
        'import() of linq/transport',
        'names linqapp.com',
      ].sort(),
    );
  });

  it('read-only and type-only imports pass', () => {
    const file = join(REPO_ROOT, NEGATIVE_FIXTURE_REL);
    const ok = [
      `import { LinqSendError, listLinqChatsPage } from "~/lib/channel/linq/transport";`,
      `import type { LinqChatPage } from './transport';`,
      `import { type LinqChatService, LINQ_MALFORMED_CHAT_PAGE } from './transport.js';`,
      `export type { LinqOutboundPart } from './transport';`,
    ].join('\n');
    expect(scanSource(file, NEGATIVE_FIXTURE_REL, ok).findings).toEqual([]);
  });

  it('no module outside the door imports a sending Linq call or names the Linq API', () => {
    expect(
      findings,
      `Import these from ~/lib/channel/outbound-transport instead, so the Preview capture switch covers them:\n  ${findings
        .map((f) => `${f.file}: ${f.why}`)
        .join('\n  ')}`,
    ).toEqual([]);
  });
});
