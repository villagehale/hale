/**
 * Hale's public profiles. The footer and the Organization JSON-LD share this
 * list so a profile cannot appear in one and not the other. No phone number.
 */
export const HALE_SOCIAL = [
  {
    id: 'x',
    href: 'https://x.com/villagehale_ai',
    label: 'socialX',
  },
  {
    id: 'instagram',
    href: 'https://www.instagram.com/villagehale_ai/',
    label: 'socialInstagram',
  },
  {
    id: 'linkedin',
    href: 'https://www.linkedin.com/company/142982951/',
    label: 'socialLinkedIn',
  },
] as const;

export const HALE_SAME_AS = HALE_SOCIAL.map((profile) => profile.href);
