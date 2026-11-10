import { f14EnabledFor } from '~/lib/channel/f14';
import { watchedSpotsEnabled } from '~/lib/channel/spots/flag';
import { authorizedSignupEnabled } from '~/lib/signup/flag';

/**
 * VIL-303 · the capabilities Hale may say no to today and yes to later.
 *
 * THIS LIST IS THE SOURCE of "is it real yet". A key's `lit` reads the same gate the
 * feature itself reads, so a capability cannot be live for the feature and dark here.
 * A capability that is coming but has no gate yet gets a key whose `lit` returns false,
 * and the change that ships it flips that to the real gate. That flip is what turns
 * every recorded no into a correction the parent hears on their next text.
 *
 * Keys are stored in `capability_denials.capability`; never rename one.
 */
export const DEFERRED_CAPABILITIES = ['sign_up', 'spot_watch'] as const;

export type DeferredCapability = (typeof DEFERRED_CAPABILITIES)[number];

const LIT: Record<DeferredCapability, (familyId: string) => boolean> = {
  // The offer_signup verb and the consent flow behind it (signup/offer-tool.ts).
  sign_up: () => authorizedSignupEnabled(),
  // The watch_for_opening dark gate, exactly (spots/tool.ts).
  spot_watch: (familyId) => watchedSpotsEnabled() && f14EnabledFor(familyId),
};

export function isDeferredCapability(value: string): value is DeferredCapability {
  return (DEFERRED_CAPABILITIES as readonly string[]).includes(value);
}

export function capabilityLit(capability: DeferredCapability, familyId: string): boolean {
  return LIT[capability](familyId);
}

/** The capabilities still dark for this family, in registry order. */
export function darkCapabilities(familyId: string): DeferredCapability[] {
  return DEFERRED_CAPABILITIES.filter((capability) => !capabilityLit(capability, familyId));
}
