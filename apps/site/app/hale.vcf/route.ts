import { buildVCard } from '~/lib/contact-card';
import { CONTACT_PHOTO_JPEG_BASE64 } from '~/lib/contact-photo';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * /hale.vcf — Hale's own contact card, so a parent who saves it once sees the
 * navy turtle and the name beside every later text instead of an unknown number.
 *
 * Unprefixed by locale on purpose: the middleware skips any path with a dot (the
 * same exclusion that keeps llms.txt and robots.txt where they are), and a vCard
 * has nothing to translate — the fields are a name, a number, and a photo.
 */

export function GET(): Response {
  const smsNumber = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);

  // The number is the card. Without it there is nothing honest to serve, so the
  // route says so plainly — the /text page hides the button in the same state.
  if (!smsNumber) {
    return new Response('Hale’s number is not provisioned yet.\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(buildVCard(smsNumber, CONTACT_PHOTO_JPEG_BASE64), {
    headers: {
      'content-type': 'text/vcard; charset=utf-8',
      'content-disposition': 'attachment; filename="Hale.vcf"',
    },
  });
}
