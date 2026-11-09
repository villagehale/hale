import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Hard rule #2 for eval judges: a judge's rubric is a managed prompt under
// apps/worker/prompts/judges (lockfile-guarded by prompts:check), never text in a runner.

const EVALS = dirname(fileURLToPath(import.meta.url));
const JUDGES = join(EVALS, '..', 'prompts', 'judges');
const JUDGE_NAME = /JUDGE_SYSTEM$|_JUDGE$|^judgeSystem$/;
const MAX_INLINE_CHARS = 80;

function evalSources() {
  const files = [];
  for (const dir of [EVALS, join(EVALS, 'lib')]) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.mjs') && !f.endsWith('.test.mjs')) files.push(join(dir, f));
    }
  }
  return files;
}

function inlineChars(node) {
  let chars = 0;
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) chars += n.text.length;
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      chars += n.text.length;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return chars;
}

/** Top-level judge declarations in `source` and how much literal text each one carries. */
function judgeDeclarations(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && JUDGE_NAME.test(d.name.text) && d.initializer) {
          found.push({ name: d.name.text, chars: inlineChars(d.initializer) });
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name && JUDGE_NAME.test(st.name.text)) {
      found.push({ name: st.name.text, chars: inlineChars(st.body) });
    }
  }
  return found;
}

const inlineOffenders = (fileName, source) =>
  judgeDeclarations(fileName, source).filter((d) => d.chars > MAX_INLINE_CHARS);

describe('eval judge rubrics are managed prompts', () => {
  it('flags an inline rubric and passes one loaded by name (positive control)', () => {
    const inline = [
      "const JUDGE_SYSTEM = ['You are a strict reviewer scoring ONE text message Hale sends,',",
      "  'Score 1-5 on meaning, not wording.'].join(' ');",
      'const CLASSIFY_JUDGE = `You score a classifier rationale for one inbound signal, 1-5. A 5 names the reason, ${x}.`;',
      "function judgeSystem(rules) { return ['You are a strict reviewer scoring ONE short reason a classifier wrote for one item from a calendar.', rules].join('\\n'); }",
    ].join('\n');
    expect(inlineOffenders('inline.mjs', inline).map((d) => d.name)).toEqual([
      'JUDGE_SYSTEM',
      'CLASSIFY_JUDGE',
      'judgeSystem',
    ]);
    const managed = [
      "const JUDGE_SYSTEM = judgePrompt('radar');",
      "const READ_JUDGE_SYSTEM = judgePrompt('group-poll-read', { reasonMaxChars: JUDGE_REASON_MAX_CHARS });",
      "function judgeSystem(rules) { return judgePrompt('kid-relevance', { verdictRules: rules }); }",
    ].join('\n');
    expect(judgeDeclarations('managed.mjs', managed)).toHaveLength(3);
    expect(inlineOffenders('managed.mjs', managed)).toEqual([]);
  });

  it('no eval runner defines judge rubric text inline', () => {
    const files = evalSources();
    let seen = 0;
    const offenders = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      seen += judgeDeclarations(file, source).length;
      for (const d of inlineOffenders(file, source)) {
        offenders.push(`${file.slice(EVALS.length + 1)}: ${d.name} (${d.chars} chars)`);
      }
    }
    expect(seen).toBeGreaterThan(60);
    expect(offenders).toEqual([]);
  });

  it('every judgePrompt name has a prompt file, and every judge prompt file is used', () => {
    const used = new Set();
    for (const file of evalSources()) {
      for (const m of readFileSync(file, 'utf8').matchAll(/judgePrompt\(\s*['"]([^'"]+)['"]/g)) {
        used.add(m[1]);
      }
    }
    const onDisk = new Set(
      readdirSync(JUDGES)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -'.md'.length)),
    );
    expect(used.size).toBeGreaterThan(60);
    expect([...used].filter((n) => !onDisk.has(n))).toEqual([]);
    expect([...onDisk].filter((n) => !used.has(n))).toEqual([]);
  });
});
