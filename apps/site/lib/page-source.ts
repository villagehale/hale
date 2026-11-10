import { parseSourceCode } from '~/lib/text-entry';

type SourceParams = {
  s?: string | string[];
  src?: string | string[];
  utm_source?: string | string[];
  utm_campaign?: string | string[];
};

/**
 * The validated source code on this request, or null. Pages hand it to every Text Hale
 * door so a no-JS client still lands on `/text?s=<code>`.
 *
 * Read order for the SMS pre-fill: `?s=`, then the poster QR's `?src=`, then
 * — on a poster link only — `utm_campaign`. Same order as the analytics side
 * (lib/analytics/source-code.ts), so the code a parent texts in is the code the visit
 * was credited to.
 */
export async function pageSource(searchParams?: Promise<SourceParams>): Promise<string | null> {
  const params = await searchParams;
  return (
    parseSourceCode(params?.s) ??
    parseSourceCode(params?.src) ??
    (params?.utm_source === 'poster' ? parseSourceCode(params?.utm_campaign) : null)
  );
}
