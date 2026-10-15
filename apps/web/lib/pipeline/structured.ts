/**
 * The structured-output seam lives in @hale/agent (packages/agent/src/structured.ts), shared
 * with the worker so the two processes can never send different request shapes again.
 * Re-exported here so web importers keep their path.
 */
export {
  type ForceToolJsonResult,
  StructuredOutputError,
  cachedSystem,
  forceToolJson,
} from '@hale/agent';

/**
 * The streamed transport for the fast parent-facing lanes, unless the
 * process asks for plain `create` (`HALE_LLM_NO_STREAM=1`): the live harness
 * and some proxies cannot carry a stream, and the turns these lanes run
 * answer in seconds either way.
 */
export function llmTransport(): 'create' | 'stream' {
  return process.env.HALE_LLM_NO_STREAM === '1' ? 'create' : 'stream';
}
