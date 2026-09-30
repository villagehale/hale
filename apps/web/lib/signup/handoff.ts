import { signupAssistedHandoffLine } from './copy';

/**
 * The locked assisted line does not clean its inputs. Collapse the whitespace
 * that used to be stripped inside copy.ts, here at the call, so a padded
 * session label or pack value cannot change Sloane's sentence.
 */
export function assistedHandoffLine(input: {
  link: string;
  sessionLabel: string;
  pack: readonly { slot: string; value: string }[];
}): string {
  return signupAssistedHandoffLine({
    link: input.link,
    sessionLabel: collapseSignupFact(input.sessionLabel),
    pack: input.pack.map((item) => ({ slot: item.slot, value: collapseSignupFact(item.value) })),
  });
}

/** Collapse whitespace at the call site. The locked sentences in copy.ts do not trim. */
export function collapseSignupFact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
