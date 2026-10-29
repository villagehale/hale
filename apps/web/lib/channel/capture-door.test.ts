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
 * skip the capture switch?". It fails when any module other than
 * outbound-transport.ts and linq/transport.ts:
 *   - imports a sending function, createLinqPhoneTransport or createLinqTextTransport
 *     from linq/transport (read-only calls, types and LinqSendError stay importable),
 *   - imports linq/transport as a namespace or dynamically, or
 *   - names the Linq API host.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const LINQ_TRANSPORT = 'apps/web/lib/channel/linq/transport.ts';
const DOOR = 'apps/web/lib/channel/outbound-transport.ts';
const ALLOWED = new Set([DOOR, LINQ_TRANSPORT]);

/** Every linq/transport export that reaches a parent's chat or Hale's line. */
const SENDING_EXPORTS = new Set([
  'createLinqPhoneTransport',
  'createLinqTextTransport',
  'sendLinqChatMessage',
  'sendLinqParts',
  'sendLinqEffect',
  'sendLinqPoll',
  'reactToLinqMessage',
  'createLinqChat',
  'updateLinqGroupChat',
  'addLinqParticipant',
  'removeLinqParticipant',
  'shareLinqContactCard',
  'setupLinqContactCard',
  'patchLinqContactCard',
  'markLinqChatRead',
  'startLinqTyping',
  'stopLinqTyping',
  'requestLinqLocation',
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

function pointsAtLinqTransport(file: string, specifier: string): boolean {
  if (specifier === '~/lib/channel/linq/transport') return true;
  if (!specifier.startsWith('.')) return false;
  const target = relative(REPO_ROOT, resolve(dirname(file), specifier));
  return `${target}.ts` === LINQ_TRANSPORT;
}

type Finding = { file: string; why: string };

function scan(): { findings: Finding[]; importers: string[] } {
  const findings: Finding[] = [];
  const importers: string[] = [];
  const IMPORT = /import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/g;
  const DYNAMIC = /import\(\s*'([^']+)'\s*\)/g;
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const rel = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, 'utf8');
      if (text.includes('api.linqapp.com') && rel !== LINQ_TRANSPORT) {
        findings.push({ file: rel, why: 'names api.linqapp.com' });
      }
      for (const m of text.matchAll(IMPORT)) {
        const [, typeOnly, clause = '', specifier = ''] = m;
        if (!pointsAtLinqTransport(file, specifier)) continue;
        importers.push(rel);
        if (ALLOWED.has(rel) || typeOnly) continue;
        if (/\*\s+as\s+/.test(clause)) {
          findings.push({ file: rel, why: 'namespace import of linq/transport' });
          continue;
        }
        const names = (clause.match(/\{([\s\S]*)\}/)?.[1] ?? '')
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n && !n.startsWith('type '))
          .map((n) => n.split(/\s+as\s+/)[0]?.trim() ?? '');
        for (const name of names) {
          if (SENDING_EXPORTS.has(name)) findings.push({ file: rel, why: `imports ${name}` });
        }
      }
      for (const m of text.matchAll(DYNAMIC)) {
        if (pointsAtLinqTransport(file, m[1] ?? '') && !ALLOWED.has(rel)) {
          findings.push({ file: rel, why: 'dynamic import of linq/transport' });
        }
      }
    }
  }
  return { findings, importers };
}

describe('every Linq send goes through outbound-transport (capture covers it)', () => {
  const { findings, importers } = scan();

  it('positive control: the scanner sees the door importing linq/transport', () => {
    expect(importers).toContain(DOOR);
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
