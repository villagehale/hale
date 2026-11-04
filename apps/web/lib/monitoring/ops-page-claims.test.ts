import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * VIL-602 · a code path that says it pages #ops pages through failure-page.ts, the one
 * module that claims and posts per-event pages. hale-web has no log drain, so a log line
 * that says "page #ops" reaches nobody. This guard makes that line unwritable: any log
 * call outside failure-page.ts whose arguments claim urgency or a #ops page fails here.
 *
 * Doc comments are not scanned: too many true claims to tell apart structurally, so the
 * PR checks them by hand.
 */

const WEB_ROOT = join(__dirname, '..', '..');
const PRIMITIVE = 'lib/monitoring/failure-page.ts';

/** One frozen line: friend-voice still pages through its own postOpsSlack (the ratchet
 * list below), so this log is true. Removed when friend-voice moves onto pageOps. */
const ALLOWED: ReadonlyArray<{ file: string; text: string }> = [
  { file: 'lib/channel/intake/friend-voice.ts', text: '#ops already paged today' },
];

type Lex = 'code' | 'string' | 'comment';

/** Classify every character as code, string or comment. A regex literal counts as a
 * string. Template `${}` bodies are code. */
function lex(source: string): Lex[] {
  const out: Lex[] = new Array(source.length);
  const stack: Array<'tpl' | 'brace'> = [];
  let i = 0;
  let lastCode = '';
  const regexAfter = new Set([
    '',
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '%',
    '<',
    '>',
    '~',
    '^',
  ]);
  const mark = (from: number, to: number, kind: Lex) => {
    for (let k = from; k < to && k < source.length; k += 1) out[k] = kind;
  };
  const template = (start: number): number => {
    // start is just past a backtick, or just past the `}` closing a `${`
    let k = start;
    while (k < source.length) {
      const ch = source[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === '`') {
        mark(start - 1, k + 1, 'string');
        return k + 1;
      }
      if (ch === '$' && source[k + 1] === '{') {
        mark(start - 1, k + 2, 'string');
        stack.push('tpl');
        return k + 2;
      }
      k += 1;
    }
    mark(start - 1, k, 'string');
    return k;
  };
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      mark(i, stop, 'comment');
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      mark(i, stop, 'comment');
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let k = i + 1;
      while (k < source.length && source[k] !== ch && source[k] !== '\n') {
        k += source[k] === '\\' ? 2 : 1;
      }
      mark(i, k + 1, 'string');
      i = k + 1;
      lastCode = ch;
      continue;
    }
    if (ch === '`') {
      i = template(i + 1);
      lastCode = '`';
      continue;
    }
    if (ch === '/' && regexAfter.has(lastCode)) {
      let k = i + 1;
      let inClass = false;
      while (k < source.length && source[k] !== '\n') {
        const c = source[k];
        if (c === '\\') {
          k += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        k += 1;
      }
      mark(i, k + 1, 'string');
      i = k + 1;
      lastCode = '/';
      continue;
    }
    if (ch === '{') stack.push('brace');
    if (ch === '}') {
      const top = stack.pop();
      if (top === 'tpl') {
        i = template(i + 1);
        lastCode = '`';
        continue;
      }
    }
    out[i] = 'code';
    if (!/\s/.test(ch)) lastCode = /[A-Za-z0-9_$)\]]/.test(ch) ? 'x' : ch;
    i += 1;
  }
  return out;
}

const OPENER = /\bconsole\.(?:error|warn|info|log|debug)\s*\(|\.log\.(?:error|warn|info)\s*\(/g;

interface LogCall {
  line: number;
  /** The call's argument text, comments removed, strings kept. */
  args: string;
}

/** Every log call in `source`, with its argument text. */
function logCalls(source: string): LogCall[] {
  const kinds = lex(source);
  const calls: LogCall[] = [];
  for (const match of source.matchAll(OPENER)) {
    const at = match.index ?? 0;
    if (kinds[at] !== 'code' && !(source[at] === '.' && kinds[at + 1] === 'code')) continue;
    const open = at + match[0].length - 1;
    let depth = 0;
    let close = open;
    for (let k = open; k < source.length; k += 1) {
      if (kinds[k] !== 'code') continue;
      if (source[k] === '(') depth += 1;
      else if (source[k] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    let args = '';
    for (let k = open + 1; k < close; k += 1) args += kinds[k] === 'comment' ? ' ' : source[k];
    calls.push({ line: source.slice(0, at).split('\n').length, args });
  }
  return calls;
}

const PAGING = /\bpag(?:e|es|ed|ing)\b[^.;:]{0,20}#ops|#ops[^.;:]{0,20}\bpag(?:e|es|ed|ing)\b/;

/** True when a log call's arguments claim urgency or a #ops page. */
function claimsPage(args: string): boolean {
  const text = args.toLowerCase().replace(/\s+/g, ' ');
  return /\burgent\b/.test(text) || PAGING.test(text);
}

/** `file:line` for each log call in `source` that claims a page and is not allowed. */
function offendersIn(file: string, source: string): string[] {
  if (file === PRIMITIVE) return [];
  return logCalls(source)
    .filter((call) => claimsPage(call.args))
    .filter(
      (call) => !ALLOWED.some((entry) => entry.file === file && call.args.includes(entry.text)),
    )
    .map((call) => `${file}:${call.line}`);
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.d\.ts$/.test(name)) continue;
    if (/\.test\.|\.fixture\./.test(name)) continue;
    files.push(path);
  }
  return files;
}

function webFiles(): Array<{ file: string; source: string }> {
  return sourceFiles(WEB_ROOT).map((path) => ({
    file: relative(WEB_ROOT, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));
}

/**
 * Files outside monitoring and the crons that post to #ops themselves, with no claim
 * dedupe. They do page; moving them onto pageOps is the named follow-up. A new direct
 * caller fails here; a removal passes.
 */
const DIRECT_PAGERS = new Set([
  'lib/channel/linq/carpool-voice.ts',
  'lib/channel/linq/group-onboarding-voice.ts',
  'lib/channel/linq/inbound.ts',
  'lib/channel/linq/roster-reading.ts',
  'lib/channel/intake/friend-voice.ts',
  'lib/channel/proactive/review.ts',
  'lib/channel/webhook-alert.ts',
  'lib/loop/reminders/group/capture.ts',
  'lib/loop/reminders/group/fire.ts',
  'lib/memory/workstream-followup.ts',
]);

function unlistedPagers(importers: readonly string[]): string[] {
  return importers.filter((file) => !DIRECT_PAGERS.has(file));
}

/** Every mention of the module; group 1 is set only on a type-only import, which posts nothing. */
const OPS_SLACK_MODULE = /(import\s+type\s[^;]*?from\s*)?['"][^'"]*\/monitoring\/ops-slack['"]/g;

function reachesOpsSlack(source: string): boolean {
  return [...source.matchAll(OPS_SLACK_MODULE)].some((match) => match[1] === undefined);
}

function postOpsSlackImporters(files: Array<{ file: string; source: string }>): string[] {
  return files
    .filter(({ file }) => !file.startsWith('lib/monitoring/') && !file.startsWith('app/api/cron/'))
    .filter(({ source }) => reachesOpsSlack(source))
    .map(({ file }) => file)
    .sort();
}

describe('ops page claims', () => {
  const files = webFiles();

  it('no log call outside failure-page.ts claims urgency or a #ops page', () => {
    const offenders = files.flatMap(({ file, source }) => offendersIn(file, source));
    expect(offenders).toEqual([]);
  });

  it('the walk read real log calls (it proves files were read)', () => {
    const count = files.reduce((sum, { source }) => sum + logCalls(source).length, 0);
    expect(count).toBeGreaterThan(300);
  });

  it('direct postOpsSlack callers are a subset of the frozen follow-up list', () => {
    expect(unlistedPagers(postOpsSlackImporters(files))).toEqual([]);
  });

  describe('positive controls', () => {
    const hits = (source: string, file = 'lib/x.ts') => offendersIn(file, source).length;

    it('a URGENT page log and an urgent key are caught', () => {
      expect(hits("console.error({ urgent: true }, 'URGENT: x - page #ops now');")).toBe(1);
    });

    it('a structured logger claiming a page is caught', () => {
      expect(hits("deps.log.error({}, 'a stop pages #ops');")).toBe(1);
    });

    it('an urgent key outside a log call is not a log claim', () => {
      expect(hits('const req = { urgent: true };')).toBe(0);
    });

    it('a comment outside a call is not scanned', () => {
      expect(hits('// page #ops\nconst a = 1;')).toBe(0);
    });

    it('a comment inside a call is not scanned', () => {
      expect(hits("console.error({ a: 1 /* page #ops */ }, 'x');")).toBe(0);
    });

    it('every paging verb form, either order, is caught', () => {
      expect(hits("console.warn('x - paging #ops');")).toBe(1);
      expect(hits("console.info({}, 'x: #ops paged');")).toBe(1);
      expect(hits('console.error(`URGENT  x`);')).toBe(1);
      expect(hits("console.error('Urgent: x');")).toBe(1);
    });

    it('a call split over lines is read whole', () => {
      expect(hits("console.error(\n  { a: '(' },\n  'x - all fine',\n);")).toBe(0);
      expect(hits("console.error(\n  { a: '(' },\n  'x - page #ops',\n);")).toBe(1);
    });

    it('the #ops post near-miss is not a claim', () => {
      expect(hits("console.error('ops daily: the #ops post did not land');")).toBe(0);
    });

    it('the allow-listed friend-voice line passes there and nowhere else', () => {
      const line =
        "console.info({ page: 'suppressed' }, 'onboarding-friend: #ops already paged today');";
      expect(hits(line, 'lib/channel/intake/friend-voice.ts')).toBe(0);
      expect(hits(line, 'lib/channel/intake/other.ts')).toBe(1);
    });

    it('failure-page.ts, the primitive, may write the log', () => {
      const line = "console.error({}, 'URGENT: x - paging #ops');";
      expect(hits(line, PRIMITIVE)).toBe(0);
      expect(hits(line, 'lib/monitoring/other.ts')).toBe(1);
    });

    it('the ratchet fails a new direct caller and passes a removal', () => {
      expect(unlistedPagers(['lib/channel/linq/carpool-voice.ts', 'lib/new-pager.ts'])).toEqual([
        'lib/new-pager.ts',
      ]);
      expect(unlistedPagers(['lib/channel/linq/carpool-voice.ts'])).toEqual([]);
    });

    it('any value import or re-export of ops-slack counts as a direct caller', () => {
      const reaches = (source: string) => postOpsSlackImporters([{ file: 'lib/x.ts', source }]);
      expect(reaches("import { postOpsSlack } from '~/lib/monitoring/ops-slack';")).toEqual([
        'lib/x.ts',
      ]);
      expect(reaches("import * as slack from '~/lib/monitoring/ops-slack';")).toEqual(['lib/x.ts']);
      expect(reaches("export { postOpsSlack } from '~/lib/monitoring/ops-slack';")).toEqual([
        'lib/x.ts',
      ]);
      expect(reaches("const m = await import('~/lib/monitoring/ops-slack');")).toEqual([
        'lib/x.ts',
      ]);
      expect(reaches("import type { OpsPageOutcome } from '~/lib/monitoring/ops-slack';")).toEqual(
        [],
      );
    });
  });
});
