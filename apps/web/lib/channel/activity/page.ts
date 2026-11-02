import type { FetchPage } from '~/lib/registration/fetch';
import {
  RegistrationPageRedirect,
  createRegistrationPageFetch,
  registrationPageUrl,
} from '~/lib/registration/page';

/** Every redirect uses the same URL validation and DNS-pinned, credential-free fetch. */
export function createActivityPageFetch(fetchPage: FetchPage = createRegistrationPageFetch()) {
  return async (raw: string): Promise<{ url: string; text: string }> => {
    let url = registrationPageUrl(raw);
    for (let hop = 0; ; hop++) {
      try {
        return { url, text: await fetchPage(url) };
      } catch (error) {
        if (!(error instanceof RegistrationPageRedirect) || hop === 3) throw error;
        url = registrationPageUrl(error.location);
      }
    }
  };
}
