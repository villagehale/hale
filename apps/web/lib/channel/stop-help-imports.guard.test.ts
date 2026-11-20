import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * VIL-706 · Barton's rule: Hale never teaches STOP or HELP. The co-parent join door and
 * the caregiver door used to import fixed sentences that ended "Reply STOP anytime"
 * (`joinWelcome`, `CAREGIVER_WELCOME`) and send them. This guard fails when a module
 * imports a string constant that teaches one.
 *
 * WHAT COUNTS AS A STOP/HELP STRING. An export whose value is a string written in the
 * source with STOP, HELP, ARRET or AIDE in it as a whole uppercase word: a string or
 * template constant, or a function that returns one (the shape `joinWelcome` had).
 * Lowercase "stop" in a sentence is a word, not a keyword.
 *
 * WHAT COUNTS AS A SEND PATH. Every non-test module under apps/web. A module that does
 * not send today can start tomorrow, and the import is the moment a keyword line could
 * ride onto a text. Test support (`lib/testing`, fixtures, journeys) is out of scope.
 *
 * The opt-out lines in `opt-out.ts` are exported for their own tests and imported by no
 * module: composers refuse them through `writesOptOutLine` and budgets read
 * `OPT_OUT_LINE_CHARS`. There is no allowlist. A new importer is a failing test, not a
 * row to add.
 */

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const REPO_ROOT = resolve(WEB_ROOT, '../..');
const SCAN_ROOTS = ['lib', 'app'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'build',
  'testing',
  '__journey__',
  '__recordings__',
  '__tests__',
]);
const SOURCE = /\.(ts|tsx)$/;
const NOT_PRODUCT = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.fixture\.ts$|\.d\.ts$/;
/** The carrier keywords, written as keywords. A test file, so the word-list guard skips it. */
const KEYWORD = /(?<![\p{L}\p{N}])(?:STOP|HELP|ARRET|ARRÊT|AIDE)(?![\p{L}\p{N}])/u;

function productFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...productFiles(full));
      continue;
    }
    if (SOURCE.test(name) && !NOT_PRODUCT.test(name)) out.push(full);
  }
  return out;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** The literal text of a string-valued expression, or null when it is not one. */
function literalText(node: ts.Expression): string | null {
  let expr = node;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) {
    return [expr.head.text, ...expr.templateSpans.map((span) => span.literal.text)].join(' ');
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(expr.left);
    const right = literalText(expr.right);
    return left === null && right === null ? null : `${left ?? ''} ${right ?? ''}`;
  }
  if (ts.isConditionalExpression(expr)) {
    const parts = [literalText(expr.whenTrue), literalText(expr.whenFalse)];
    return parts.every((p) => p === null) ? null : parts.join(' ');
  }
  return null;
}

function teaches(expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  const text = literalText(expr);
  return text !== null && KEYWORD.test(text);
}

/** Whether a function returns a string that teaches a keyword. */
function functionTeaches(fn: ts.SignatureDeclaration & { body?: ts.Node }): boolean {
  const body = fn.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return teaches(body as ts.Expression);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isReturnStatement(node) && teaches(node.expression)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** The names a module exports whose value teaches a keyword. */
function keywordExports(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (teaches(init)) names.add(decl.name.text);
        else if (
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          functionTeaches(init)
        )
          names.add(decl.name.text);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (functionTeaches(statement)) names.add(statement.name.text);
    }
  }
  return names;
}

interface ImportedName {
  spec: string;
  /** The exported name, `*` for a namespace import. */
  imported: string;
}

/** Value imports and re-exports (a type-only import carries no string). */
function importedNames(source: ts.SourceFile): ImportedName[] {
  const out: ImportedName[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const spec = statement.moduleSpecifier.text;
      if (clause.name) out.push({ spec, imported: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) out.push({ spec, imported: '*' });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) continue;
          out.push({ spec, imported: (el.propertyName ?? el.name).text });
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const spec = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      if (!clause) out.push({ spec, imported: '*' });
      else if (ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (!el.isTypeOnly) out.push({ spec, imported: (el.propertyName ?? el.name).text });
        }
      }
    }
  }
  return out;
}

interface Reexport {
  exported: string;
  spec: string;
  imported: string;
}

/**
 * What a module passes on under its own name: `export { a as b } from`, `export * from`,
 * and an imported binding exported again (`import { a } from …; export { a }`). A keyword
 * string re-exported under another name is still that string.
 */
function reexports(source: ts.SourceFile): Reexport[] {
  const out: Reexport[] = [];
  const imported = new Map<string, { spec: string; imported: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!clause || clause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue;
      imported.set(el.name.text, {
        spec: statement.moduleSpecifier.text,
        imported: (el.propertyName ?? el.name).text,
      });
    }
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const clause = statement.exportClause;
    if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      if (!clause) out.push({ exported: '*', spec, imported: '*' });
      else if (ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (el.isTypeOnly) continue;
          out.push({ exported: el.name.text, spec, imported: (el.propertyName ?? el.name).text });
        }
      }
    } else if (clause && ts.isNamedExports(clause)) {
      for (const el of clause.elements) {
        if (el.isTypeOnly) continue;
        const local = imported.get((el.propertyName ?? el.name).text);
        if (local) out.push({ exported: el.name.text, ...local });
      }
    }
  }
  return out;
}

function stemOf(file: string): string {
  return (file.split('/').pop() ?? file).replace(/\.tsx?$/, '');
}

function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('~/')) base = join(WEB_ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function violations(): string[] {
  const files = SCAN_ROOTS.flatMap((root) => productFiles(join(WEB_ROOT, root)));
  const texts = new Map(files.map((file) => [file, readFileSync(file, 'utf8')] as const));
  const parsed = new Map<string, ts.SourceFile>();
  const ast = (file: string): ts.SourceFile => {
    let source = parsed.get(file);
    if (!source) {
      source = parse(file, texts.get(file) ?? '');
      parsed.set(file, source);
    }
    return source;
  };
  // Only a file that names a module's file stem can import it, so a stem is the cheap
  // filter in front of the parse.
  const mentions = (stems: readonly string[]) =>
    [...texts.keys()].filter((file) => stems.some((stem) => texts.get(file)?.includes(stem)));

  const teaching = new Map<string, Set<string>>();
  for (const [file, text] of texts) {
    if (!KEYWORD.test(text)) continue;
    const names = keywordExports(ast(file));
    if (names.size > 0) teaching.set(file, names);
  }
  // A re-export carries a keyword string on under its own name, to a fixpoint.
  let frontier = [...teaching.keys()];
  while (frontier.length > 0) {
    const grown: string[] = [];
    for (const file of mentions(frontier.map(stemOf))) {
      for (const alias of reexports(ast(file))) {
        const target = resolveSpec(file, alias.spec);
        const names = target && target !== file ? teaching.get(target) : undefined;
        if (!names) continue;
        const carried =
          alias.imported === '*' ? [...names] : names.has(alias.imported) ? [alias.exported] : [];
        const own = teaching.get(file) ?? new Set<string>();
        const before = own.size;
        for (const name of carried) own.add(name);
        if (own.size > before) {
          teaching.set(file, own);
          grown.push(file);
        }
      }
    }
    frontier = grown;
  }

  const found: string[] = [];
  for (const file of mentions([...teaching.keys()].map(stemOf))) {
    for (const { spec, imported } of importedNames(ast(file))) {
      const target = resolveSpec(file, spec);
      if (!target || target === file) continue;
      const names = teaching.get(target);
      if (!names) continue;
      const hits = imported === '*' ? [...names] : names.has(imported) ? [imported] : [];
      for (const name of hits) {
        found.push(
          `${relative(REPO_ROOT, file)} imports ${name} from ${relative(REPO_ROOT, target)}`,
        );
      }
    }
  }
  return [...new Set(found)].sort();
}

describe('a send path imports no string that teaches STOP or HELP', () => {
  it('finds no importer anywhere in apps/web', () => {
    expect(violations()).toEqual([]);
  }, 60_000);

  it('positive control: the scan sees a keyword constant, a keyword function, and the real opt-out lines', () => {
    const fixture = parse(
      'fixture.ts',
      [
        'export const WELCOME = "You\'re in. Reply STOP anytime.";',
        "export const QUIET = 'Tell me if you want me to stop.';",
        'export function joinWelcome(who: string): string {',
        "  return `You're in - ${who} added you. Reply STOP anytime.`;",
        '}',
        'export const help = (n: string) => `${n}: text HELP for help`;',
        "export const ARRET_FR = 'Répondez ARRET pour arrêter.';",
        "const PRIVATE = 'Reply STOP';",
      ].join('\n'),
    );
    expect([...keywordExports(fixture)].sort()).toEqual([
      'ARRET_FR',
      'WELCOME',
      'help',
      'joinWelcome',
    ]);

    const optOut = join(WEB_ROOT, 'lib/channel/opt-out.ts');
    const real = keywordExports(parse(optOut, readFileSync(optOut, 'utf8')));
    expect([...real].sort()).toEqual(['OPT_OUT_LINE', 'OPT_OUT_SHORT']);
  });

  it('positive control: a re-export under another name is followed', () => {
    const shell = parse(
      'shell.ts',
      [
        "export { OPT_OUT_LINE as NUDGE_OPT_OUT } from '../opt-out';",
        "import { WELCOME, type Kind } from './copy';",
        'export { WELCOME as HELLO };',
        "export * from './more-copy';",
        "export type { Other } from './other';",
      ].join('\n'),
    );
    expect(reexports(shell)).toEqual([
      { exported: 'NUDGE_OPT_OUT', spec: '../opt-out', imported: 'OPT_OUT_LINE' },
      { exported: 'HELLO', spec: './copy', imported: 'WELCOME' },
      { exported: '*', spec: './more-copy', imported: '*' },
    ]);
  });

  it('positive control: a value import is read, a type-only import is not', () => {
    const importer = parse(
      'importer.ts',
      [
        "import { OPT_OUT_LINE, type OptOutForm } from '~/lib/channel/opt-out';",
        "import type { Other } from './other';",
        "import * as copy from './copy';",
        "export { joinWelcome } from './join-copy';",
      ].join('\n'),
    );
    expect(importedNames(importer)).toEqual([
      { spec: '~/lib/channel/opt-out', imported: 'OPT_OUT_LINE' },
      { spec: './copy', imported: '*' },
      { spec: './join-copy', imported: 'joinWelcome' },
    ]);
  });
});
