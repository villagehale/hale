import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-160 · structural tripwire for the CLASSIFY stage's model input.
 *
 * SCOPE, stated honestly. This guards ONE model input: the inbound signal the
 * classify stage sends (`signal.raw_content`). It does NOT say "every model
 * input in Hale is redacted" — coach, drafter and the (currently dead)
 * lib/sentinel path are outside it by design, and wiring sentinel without giving
 * extractChildEvent the same input-owns-redaction shape re-opens this ticket
 * wider.
 *
 * And within that scope the type makes redaction UNFORGETTABLE, not
 * UNFALSIFIABLE: `childNames: []` type-checks, and it is a legitimate value for
 * a childless family. (b) below catches an empty-array literal or a stray
 * variable AT the redactor call; it cannot catch a caller that binds an empty
 * array upstream and passes it as `childNames`. That residual closes only when
 * the child-name list is branded at its loader (named follow-up), and until then
 * the caller still owes the family's real names.
 *
 * The evals are deliberately outside the walk: evals/run-eval.mjs REPLICATES the
 * classifier request rather than calling runClassifier, and its divergence from
 * prod (un-redacted fixture text) is a filed follow-up, not a leak.
 *
 * Modelled on apps/web/lib/teen-access-outbound.test.ts.
 */

const WORKER_SRC = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const WEB_LIB = fileURLToPath(new URL('../../../web/lib', import.meta.url)).replace(/\/$/, '');

const WORKER_CLASSIFIER = `${WORKER_SRC}/agents/classifier.ts`;
const WEB_CLASSIFY = `${WEB_LIB}/pipeline/classify.ts`;

/**
 * The only files allowed to name the wire key `raw_content`, and why. The two
 * classify stages PRODUCE it and redact internally; mask.ts names it in order to
 * MASK it, which makes it a consumer, not a producer.
 */
const ALLOWED: Array<[string, string]> = [
  [WORKER_CLASSIFIER, 'the worker classify stage — redacts its own input'],
  [WEB_CLASSIFY, 'the web classify stage — redacts its own input'],
  [`${WEB_LIB}/telemetry/mask.ts`, 'names the field in order to MASK it (a consumer, not a producer)'],
];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('the classify stage owns the redaction of its own model input (VIL-160)', () => {
  it('no file outside the two classify stages builds a raw_content signal', () => {
    const files = [...walk(WORKER_SRC), ...walk(WEB_LIB)];
    // Guard the guard: a walk rooted at the wrong path would assert nothing at
    // all, and would still pass with an empty offender list.
    expect(walk(WORKER_SRC).length).toBeGreaterThan(0);
    expect(walk(WEB_LIB).length).toBeGreaterThan(0);

    const hits = files.filter((file) => readFileSync(file, 'utf8').includes('raw_content'));
    expect(hits).toContain(WORKER_CLASSIFIER);
    expect(hits).toContain(WEB_CLASSIFY);

    const allowed = ALLOWED.map(([file]) => file);
    expect(hits.filter((file) => !allowed.includes(file))).toEqual([]);
  });

  for (const [file, why] of [
    [WORKER_CLASSIFIER, 'worker classify stage'] as const,
    [WEB_CLASSIFY, 'web classify stage'] as const,
  ]) {
    describe(`${why}`, () => {
      it('builds exactly one raw_content signal', () => {
        // (a) allowlists the FILE, so without this the allowlist would grant a
        // second producer appended anywhere in the same module — and the
        // binding assertion below reads only the first `raw_content:`. One
        // producer per allowlisted file is what makes that assertion total.
        const source = readFileSync(file, 'utf8');
        expect(source.match(/\braw_content\b/g)?.length).toBe(1);
      });

      it('assigns raw_content from the redactor, called with the input it was given', () => {
        const source = readFileSync(file, 'utf8');
        expect(source).toContain('redactEventPayload');

        // The only binding sent as raw_content must be the one the redactor
        // produced, from THIS call's payload and THIS family's names. The
        // literal second argument is the point: `[]`, a stray variable, or a
        // dropped argument all fail here.
        const binding = source.match(/raw_content:\s*([A-Za-z_$][\w$]*)/)?.[1];
        expect(binding).toBeDefined();
        expect(source).toContain(
          `${binding} = JSON.stringify(redactEventPayload(input.payload, input.childNames))`,
        );
      });

      it('declares no rawContent field — there is no way to hand it a raw string', () => {
        // Even an OPTIONAL `rawContent?: string` re-opens the hole: a caller
        // could flatten and pass whatever it liked, and nothing downstream could
        // tell it from a redacted string.
        expect(readFileSync(file, 'utf8')).not.toMatch(/\brawContent\??:/);
      });
    });
  }
});
