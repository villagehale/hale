import { type SaidLineInput, type SaidLineWriter, acceptSaidLine } from './said-line';

/**
 * Test stand-in for the said-line model: writes a plain line from the facts and runs
 * the same acceptance check production does. Not copy anyone receives; it lets the
 * tests assert structure (the link is there, whole, once) without a live call.
 */
export function scriptedSaidLine(calls: SaidLineInput[] = []): SaidLineWriter {
  return {
    async write(input) {
      calls.push(input);
      const facts = Object.entries(input.facts)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      return acceptSaidLine(`[${input.purpose}/${input.language ?? 'en'}]\n${facts}`, input);
    },
  };
}
