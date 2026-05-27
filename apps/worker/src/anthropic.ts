import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

let client: Anthropic | undefined;

/**
 * Singleton Anthropic SDK client. Constructed lazily on first call so
 * the worker boots even if ANTHROPIC_API_KEY isn't set yet (the call
 * sites throw a clear error at request time).
 */
export function anthropic(): Anthropic {
  if (!client) {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Configure it in your environment to enable agent calls.',
      );
    }
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return client;
}
