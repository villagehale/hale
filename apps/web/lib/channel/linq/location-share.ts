import { retrieveLinqLocation } from './transport';

/**
 * Coarse city after a parent accepts the location card. The Linq door drops
 * the street address before this returns. No send happens here — the intake
 * transport writes the next bubble.
 */
export async function readSharedLocality(
  chatId: string,
  fetchImpl?: typeof fetch,
): Promise<Awaited<ReturnType<typeof retrieveLinqLocation>>> {
  return retrieveLinqLocation({ chatId, fetch: fetchImpl });
}
