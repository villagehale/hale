// Eval judge rubrics are managed prompts (CLAUDE.md hard rule #2): authored in Langfuse,
// synced to apps/worker/prompts/judges/<name>.md and guarded by prompts:check against
// .langfuse-lock.json. The file bytes are the judge's system text, so they stay in every
// judge cache key: an edit re-keys that judge's verdicts instead of reusing stale ones.
//
// `{{name}}` is a Langfuse prompt variable. A runner fills it with a value its code owns
// (a reason cap the schema also enforces, a rule a fixture also carries).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JUDGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'judges');
const VARIABLE = /\{\{(\w+)\}\}/g;

export function renderJudgePrompt(name, text, variables = {}) {
  const used = new Set();
  const rendered = text.replace(VARIABLE, (_, key) => {
    if (!Object.hasOwn(variables, key)) {
      throw new Error(`judge prompt ${name}: no value for {{${key}}}`);
    }
    used.add(key);
    return String(variables[key]);
  });
  for (const key of Object.keys(variables)) {
    if (!used.has(key)) throw new Error(`judge prompt ${name}: {{${key}}} is not in the prompt`);
  }
  return rendered;
}

/** The managed judge prompt `judges/<name>`, with its variables filled. */
export function judgePrompt(name, variables) {
  return renderJudgePrompt(name, readFileSync(join(JUDGES_DIR, `${name}.md`), 'utf8'), variables);
}
