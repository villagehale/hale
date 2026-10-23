import { gunzipSync } from 'node:zlib';

/**
 * Test-only: decode the ONE event in a posthog-node `/batch/` request body (gzip or
 * plain JSON). Returns the decoded text too, so a test can assert a string is absent
 * from everything that left. `ours` is the event's properties minus posthog-node's own
 * `$`-prefixed library keys.
 */
export function decodeBatch(init: RequestInit | undefined): {
  text: string;
  api_key: string;
  events: { event: string; distinct_id: string; properties: Record<string, unknown> }[];
} {
  const raw = init?.body;
  let text: string;
  if (raw instanceof Uint8Array) {
    const buf = Buffer.from(raw);
    text =
      buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  } else {
    text = String(raw);
  }
  const body = JSON.parse(text) as {
    api_key: string;
    batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[];
  };
  return { text, api_key: body.api_key, events: body.batch };
}

export function ours(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([k]) => !k.startsWith('$')));
}
