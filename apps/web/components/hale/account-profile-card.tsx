import { FamilyParent } from '~/components/hale/family-parent';
import type { ViewerProfile } from '~/lib/family';

/** The first initial for the neutral monogram avatar — we hold no parent photo, so
 * a calm monogram stands in (never a fabricated face), matching the child header. */
function initialOf(name: string | null, email: string): string {
  const from = name?.trim() || email;
  return from.charAt(0).toUpperCase() || '·';
}

/** "en-CA" → "English (Canada)". Intl.DisplayNames renders the language (and, when
 * a region is present, the country) in the parent's own locale. Guards an invalid
 * tag by falling back to the raw string — honest, never a throw. */
export function humanizeLocale(locale: string): string {
  try {
    const [language] = locale.split('-');
    const languageName = new Intl.DisplayNames([locale], { type: 'language' }).of(
      language ?? locale,
    );
    if (!languageName) return locale;
    const region = locale.split('-')[1];
    if (!region) return languageName;
    const regionName = new Intl.DisplayNames([locale], { type: 'region' }).of(region);
    return regionName ? `${languageName} (${regionName})` : languageName;
  } catch {
    return locale;
  }
}

/** "America/Toronto" → "Toronto (GMT−4)". The city comes from the IANA zone's last
 * segment; the offset from a formatted short zone name in that zone. Guards an
 * invalid zone by falling back to the raw string — honest, never a throw. */
export function humanizeTimezone(timezone: string, locale: string): string {
  const city = timezone.split('/').pop()?.replaceAll('_', ' ') ?? timezone;
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const offset = parts.find((p) => p.type === 'timeZoneName')?.value;
    return offset ? `${city} (${offset})` : city;
  } catch {
    return timezone;
  }
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-y-1 border-t border-rule pt-4 first:border-t-0 first:pt-0 sm:flex-row sm:items-baseline sm:gap-x-6">
      <dt className="field-label sm:w-32 sm:shrink-0">{label}</dt>
      <dd className="text-spruce break-words" data-hale-pii>
        {value}
      </dd>
    </div>
  );
}

/**
 * Profile information (mockup panel 6): a monogram avatar + the parent's identity.
 * Only the fields the `users` row actually holds — Name, Email, Timezone, Language.
 * NO phone (no column), NO units/temperature/week-start (no columns) — rendering
 * them would fabricate data this product must never invent (rule #1). Name stays
 * editable via FamilyParent (email read-only, the account identity); Timezone and
 * Language are read-only display rows, humanized with Intl.
 */
export function AccountProfileCard({ profile }: { profile: ViewerProfile }) {
  return (
    <div className="card space-y-8">
      <div className="flex items-center gap-4" data-hale-pii>
        <span
          className="shrink-0 grid place-items-center size-14 rounded-full bg-apricot-tint text-apricot-deep font-display text-[1.5rem]"
          aria-hidden="true"
        >
          {initialOf(profile.name, profile.email)}
        </span>
        <div className="min-w-0">
          <p className="font-display text-[1.35rem] leading-tight truncate">
            {profile.name?.trim() || 'your account'}
          </p>
          <p className="meta mt-0.5 text-slate-green break-words">{profile.email}</p>
        </div>
      </div>

      <dl className="flex flex-col gap-y-4">
        <ProfileRow label="Timezone" value={humanizeTimezone(profile.timezone, profile.locale)} />
        <ProfileRow label="Language" value={humanizeLocale(profile.locale)} />
      </dl>

      <div className="border-t border-rule pt-8">
        <FamilyParent name={profile.name} email={profile.email} />
      </div>
    </div>
  );
}
