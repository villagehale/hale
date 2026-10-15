/**
 * Shared pieces the public RSVP page still uses. The activity-share card that used
 * to live beside it is gone; these two remain because RSVP links here.
 */

/** The single join target for a public RSVP — the in-app entry where a non-user signs up. */
export const JOIN_HREF = '/sign-in';

/** The shared footer stating the privacy posture plainly. */
export function PublicColophon() {
  return (
    <footer className="flex flex-wrap items-baseline justify-between gap-y-2 text-faded-sage">
      <p className="meta">only a coarse area is ever shared · never a precise location</p>
      <p className="meta">gathered by Hale · villagehale.com</p>
    </footer>
  );
}
