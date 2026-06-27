import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing for email+password credentials. argon2id (the @node-rs default
 * algorithm) is the OWASP-recommended memory-hard KDF; the encoded hash carries
 * its own params + per-hash salt, so `verifyPassword` needs only the stored string.
 * Plaintext is never stored or logged (rule #1).
 *
 * Params: 19 MiB memory, 2 iterations, parallelism 1 — the OWASP minimum baseline,
 * a sensible cost on Vercel's serverless CPUs without making sign-in feel slow.
 */
const ARGON2_OPTS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTS);
}

/**
 * Constant-time verify against the stored encoded hash. Returns false (never
 * throws) on a malformed/legacy hash so a corrupt row degrades to "wrong
 * password" rather than a 500 that leaks which account exists.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}
