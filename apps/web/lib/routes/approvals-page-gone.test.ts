import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isProtectedPath } from '~/lib/auth/protected-routes';

/**
 * Approvals happen in the text thread. The page is deleted, so Next answers 404
 * and the Edge gate does not turn that 404 into a sign-in redirect. The smoke
 * walk asks the running app for the 404; this keeps the page from coming back.
 */

const WEB = fileURLToPath(new URL('../../', import.meta.url));

describe('/approvals is deleted', () => {
  it('has no page module, and the path is not gated', () => {
    expect(existsSync(`${WEB}app/(authed)/trail/page.tsx`)).toBe(true);
    expect(existsSync(`${WEB}app/(authed)/approvals/page.tsx`)).toBe(false);
    expect(existsSync(`${WEB}app/(authed)/approvals`)).toBe(false);
    expect(isProtectedPath('/approvals')).toBe(false);
  });
});
