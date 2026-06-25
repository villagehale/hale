import { ExternalLink } from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import { registerLinkHref } from '~/lib/village/register-link';

/**
 * The SECONDARY action on every village/public activity card: a clearly-labelled,
 * bordered link out to the provider's listing, where a parent reads the details
 * and registers. In-app "add to my week" stays the primary; this is the bordered
 * secondary beside it. The href always resolves (registerLinkHref falls back to a
 * coarse-area search when there is no source URL), so a parent can always get
 * through to registration. Opens in a new tab.
 */
export function RegisterLink({
  sourceUrl,
  title,
  area,
}: {
  sourceUrl: string | null;
  title: string;
  area: string | null;
}) {
  return (
    <a
      href={registerLinkHref(sourceUrl, title, area)}
      target="_blank"
      rel="noreferrer"
      className="btn-secondary"
    >
      view details &amp; register
      <Icon as={ExternalLink} size={16} className="shrink-0" />
    </a>
  );
}
