import type { MetadataRoute } from 'next';
import { SITE_URL } from '~/lib/app-url';

// The answer engines we want citing our cited, sourced answer pages. Listed
// explicitly (as well as the `*` allow) so a future tightening of the wildcard
// rule can never silently lock the AI crawlers out — being quotable by these is
// the whole point of the answer corpus. Per-page noindex still governs what is
// indexable, so held drafts stay out regardless of this allow.
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'ClaudeBot',
  'anthropic-ai',
  'Claude-User',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: '/' })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
