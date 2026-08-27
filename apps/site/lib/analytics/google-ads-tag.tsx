import { GOOGLE_ADS_BOOTSTRAP, GOOGLE_ADS_GTAG_SRC } from './google-ads';

/**
 * Google's gtag snippet, rendered into the document head of every public
 * marketing page. Kept as real `<script>` tags (not next/script afterInteractive)
 * so the Ads id is present in view-source, which is how Google confirms the tag.
 *
 * Server component on purpose — this is static HTML, not a client provider.
 */
export function GoogleAdsTag() {
  return (
    <>
      <script async src={GOOGLE_ADS_GTAG_SRC} />
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the gtag bootstrap
          must run as a raw inline script in the document head. */}
      <script dangerouslySetInnerHTML={{ __html: GOOGLE_ADS_BOOTSTRAP }} />
    </>
  );
}
