import { threadOnboardingV2Enabled } from '~/lib/channel/intake/thread-onboarding-v2';
import { appBaseUrl } from '~/lib/cron/email-compliance';

/** Where every texted connect link starts: Hale's own redeem page, on the app host. */
export function connectLinkPrefix(): string {
  return `${appBaseUrl()}/connect?`;
}

/**
 * VIL-721. A connect link Hale minted, as the thread may keep it: its target and no
 * sign-in token. Later turns re-read this text, and the token signs its holder in. A
 * `/connect` link on any other host is someone else's and is left alone. Dark, the text
 * is stored as it always was.
 */
export function withoutConnectTokens(text: string): string {
  if (!threadOnboardingV2Enabled()) return text;
  const prefix = connectLinkPrefix();
  const [before = '', ...links] = text.split(prefix);
  const kept = links.map((link) => {
    const end = link.search(/[\s#]/);
    const query = end === -1 ? link : link.slice(0, end);
    const params = query.split('&').filter((param) => !param.startsWith('t='));
    return params.join('&') + (end === -1 ? '' : link.slice(end));
  });
  return [before, ...kept].join(prefix);
}
