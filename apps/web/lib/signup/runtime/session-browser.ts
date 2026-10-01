import { rawSnapshotToPage } from '../snapshot-in-page';
import type { PageSnapshot, SignupBrowser, SignupPage } from '../types';
import { registrationUrlAllowed } from '../url';
import type { HandsResponse, SignupHandsCommand, SignupHandsSession } from './protocol';

/**
 * SignupBrowser over a hands session.
 *
 * The session already exists. This object only forwards open / snapshot / fill /
 * select / continue / submit / close. It does not see the family record.
 * A refused URL is not sent. The session is stopped if open fails, and on close.
 */
export function sessionSignupBrowser(session: SignupHandsSession): SignupBrowser {
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await session.stop();
  };

  return {
    async open(url: string): Promise<SignupPage> {
      const allowed = registrationUrlAllowed(url);
      if (!allowed.ok) {
        await stop();
        throw new Error('url_refused');
      }
      try {
        await execute(session, { op: 'open', url: allowed.href });
      } catch (err) {
        await stop();
        throw err;
      }
      return {
        async snapshot(): Promise<PageSnapshot> {
          const result = await execute(session, { op: 'snapshot' });
          if (!result.snapshot) throw new Error('browser_unavailable');
          return rawSnapshotToPage(result.snapshot);
        },
        async fill(name: string, value: string): Promise<void> {
          await execute(session, { op: 'fill', name, value });
        },
        async select(name: string, value: string): Promise<void> {
          await execute(session, { op: 'select', name, value });
        },
        async continue(): Promise<void> {
          await execute(session, { op: 'continue' });
        },
        async submit(): Promise<void> {
          await execute(session, { op: 'submit' });
        },
        close: stop,
      };
    },
  };
}

async function execute(
  session: SignupHandsSession,
  command: SignupHandsCommand,
): Promise<Extract<HandsResponse, { ok: true }>> {
  const result = await session.exec(command);
  if (!result.ok) {
    throw new Error(result.error === 'url_refused' ? 'url_refused' : 'browser_unavailable');
  }
  return result;
}
