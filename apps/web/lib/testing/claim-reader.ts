import type {
  ClaimReadFailure,
  ClaimReader,
  ReadClaim,
} from '~/lib/channel/reconcile/claim-reader';
import { type Segment, segmentSentences } from '~/lib/channel/reconcile/sentences';

/**
 * A scripted claim reader for MECHANICS tests: what a lane does with a reading. What the
 * model actually reads is the claim-read eval's job, on real recordings (rule #8). The
 * segments are the production segmenter's, so a script cites the indices production
 * would number.
 */
export function scriptedClaimReader(
  script: (segments: readonly Segment[]) => ReadClaim[] | ClaimReadFailure,
): ClaimReader & { bodies: string[] } {
  const reader = {
    bodies: [] as string[],
    async read(input: Parameters<ClaimReader['read']>[0]) {
      reader.bodies.push(input.body);
      const segments = segmentSentences(input.body, 'en');
      const claims = script(segments);
      if (typeof claims === 'string') {
        return {
          status: 'failed' as const,
          reason: claims,
          attempts: 1 as const,
          latencyMs: 0,
          deadline: false,
        };
      }
      return {
        status: 'read' as const,
        segments,
        claims,
        usage: { input: 0, output: 0 },
        latencyMs: 0,
        attempts: 1 as const,
      };
    },
  };
  return reader;
}
