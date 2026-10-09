import { parseSourceCode } from '~/lib/text-entry';

/** The validated `?s=` on this request, or null. Pages hand it to every Text Hale door
 * so a no-JS client still lands on `/text?s=<code>`. */
export async function pageSource(
  searchParams?: Promise<{ s?: string | string[] }>,
): Promise<string | null> {
  return parseSourceCode((await searchParams)?.s);
}
