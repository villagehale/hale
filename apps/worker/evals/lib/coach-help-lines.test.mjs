import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { coachHelpLines } from './coach-help-lines.mjs';

const BUILDERS = new Set(['coachHelpLines', 'fixtureHealthPlace']);

/**
 * True when the runner imports a help-line builder from coach-help-lines.mjs and calls it.
 * Read from the syntax tree, so a comment or a string that names the builder is not a call.
 */
function buildsHelpLines(source) {
  const file = ts.createSourceFile('runner.mjs', source, ts.ScriptTarget.Latest, true);
  const imported = new Set();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith('/coach-help-lines.mjs')
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (BUILDERS.has((element.propertyName ?? element.name).text)) {
            imported.add(element.name.text);
          }
        }
      }
    }
  }
  let called = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      imported.has(node.expression.text)
    ) {
      called = true;
    }
    if (!called) ts.forEachChild(node, visit);
  };
  visit(file);
  return called;
}

const EVALS = join(dirname(fileURLToPath(import.meta.url)), '..');
const runnerSource = (name) => readFileSync(join(EVALS, name), 'utf8');

describe('coachHelpLines: a fixture row gets the lines production would hand it (VIL-589)', () => {
  it('an Ontario fixture carries 811 and 911; a US fixture and any group turn carry no 811', async () => {
    const said = async (location, audience) =>
      JSON.stringify(await coachHelpLines(location, audience));

    const ontario = await said({ province: 'ON', country: 'CA' });
    expect(ontario).toMatch(/\b811\b/);
    expect(ontario).toMatch(/\b911\b/);
    for (const elsewhere of [
      await said({ province: 'OH', country: 'US' }),
      await said({ province: 'ON', country: 'CA' }, 'group'),
    ]) {
      expect(elsewhere).not.toMatch(/811/);
      expect(elsewhere).toMatch(/\b911\b/);
    }
  });
});

describe('every runner that loads the coach skill hands it the helpLines production sends', () => {
  it('a run-*.mjs loading coach-channel-sms imports a help-line builder and calls it', () => {
    const runners = readdirSync(EVALS).filter(
      (name) => /^run-.*\.mjs$/.test(name) && runnerSource(name).includes('coach-channel-sms'),
    );
    expect(runners).toContain('run-coach-channel-eval.mjs');
    expect(runners.filter((name) => !buildsHelpLines(runnerSource(name)))).toEqual([]);
  });

  it('the coach-reaction runner as #1261 shipped it, a comment, or an uncalled import does not count', () => {
    const reaction = runnerSource('run-coach-reaction-eval.mjs');
    const importLine = "import { coachHelpLines } from './lib/coach-help-lines.mjs';\n";
    const call = 'contextFor(fixture, await coachHelpLines(LOCATION))';
    expect(reaction).toContain(importLine);
    expect(reaction).toContain(call);
    expect(buildsHelpLines(reaction)).toBe(true);

    // #1261's shape: the context built with no help lines at all.
    const shipped = reaction.replace(importLine, '').replace(call, 'contextFor(fixture)');
    expect(buildsHelpLines(shipped)).toBe(false);

    const commentOnly = reaction.replace(call, `/* ${call} */ contextFor(fixture)`);
    expect(commentOnly).toContain('coachHelpLines(');
    expect(buildsHelpLines(commentOnly)).toBe(false);

    const uncalled = reaction.replace(call, 'contextFor(fixture)');
    expect(buildsHelpLines(uncalled)).toBe(false);

    const localNamesake = `function coachHelpLines() { return []; }\n${shipped.replace('contextFor(fixture)', call)}`;
    expect(buildsHelpLines(localNamesake)).toBe(false);
  });
});
