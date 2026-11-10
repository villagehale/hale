import { stripHtml } from '~/lib/registration/fetch';
import {
  type RegistrationPageFetch,
  createRegistrationPageBytesFetch,
  registrationPageUrl,
} from '~/lib/registration/page';

/** One opened activity source: the URL that answered, and the page text. */
export type ActivityPage = { url: string; text: string };

/**
 * Open an activity source the way registration pages are opened: DNS-pinned, no
 * credentials, redirects validated before they are followed. Three hops, then stop.
 */
export function createActivityPageFetch(
  fetchBody: (url: string) => Promise<RegistrationPageFetch> = createRegistrationPageBytesFetch(),
): (raw: string) => Promise<ActivityPage> {
  return async (raw) => {
    const first = registrationPageUrl(raw);
    if (first.outcome === 'refused') throw new Error(`unsafe URL (${first.reason})`);
    let url = first.url;
    for (let hop = 0; hop <= 3; hop++) {
      const result = await fetchBody(url);
      if (result.outcome === 'fetched') {
        return { url, text: stripHtml(result.body.toString('utf8')) };
      }
      if (result.outcome === 'redirected' && hop < 3) {
        const next = registrationPageUrl(result.location, url);
        if (next.outcome === 'refused') throw new Error(`unsafe URL (${next.reason})`);
        url = next.url;
        continue;
      }
      const detail =
        result.outcome === 'redirected'
          ? 'redirect loop'
          : 'reason' in result
            ? result.reason
            : 'unknown';
      throw new Error(`activity page: ${detail}`);
    }
    throw new Error('activity page: redirect loop');
  };
}
