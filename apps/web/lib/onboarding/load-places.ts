/**
 * Loads the Google Maps JS "places" library (the New Places Autocomplete) on the
 * client, on demand. Returns the `PlaceAutocompleteElement` constructor, or null
 * if the API key is absent or the script fails to load — the caller degrades to
 * manual address entry (rule: degrade gracefully if the key/script fails).
 *
 * The bootstrap loader is injected at most once per page and memoised, so multiple
 * address fields share a single script + a single in-flight load. We never log the
 * key or any address (rule #1).
 */

type PlaceAutocompleteElementCtor = new (options: {
  includedRegionCodes?: string[];
}) => HTMLElement;

interface MapsGlobal {
  maps?: {
    importLibrary?: (name: string) => Promise<unknown>;
  };
}

let loadPromise: Promise<PlaceAutocompleteElementCtor | null> | null = null;

/**
 * Inject the Maps JS bootstrap loader exactly once. Mirrors Google's official
 * inline bootstrap, adapted to set the key from NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.
 * No-op (and no script) when the key is missing.
 */
function injectBootstrap(apiKey: string): void {
  const g = (window as unknown as { google?: MapsGlobal }).google;
  if (g?.maps?.importLibrary) {
    return;
  }
  const params = new URLSearchParams({ key: apiKey, v: 'weekly', libraries: 'places' });
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}&loading=async&callback=__halePlacesReady`;
  script.async = true;
  document.head.appendChild(script);
}

export function loadPlacesAutocomplete(): Promise<PlaceAutocompleteElementCtor | null> {
  if (loadPromise) {
    return loadPromise;
  }
  loadPromise = new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(null);
      return;
    }
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      resolve(null);
      return;
    }

    const ready = async () => {
      const importLibrary = (window as unknown as { google?: MapsGlobal }).google?.maps
        ?.importLibrary;
      if (!importLibrary) {
        resolve(null);
        return;
      }
      try {
        const lib = (await importLibrary('places')) as {
          PlaceAutocompleteElement?: PlaceAutocompleteElementCtor;
        };
        resolve(lib.PlaceAutocompleteElement ?? null);
      } catch {
        resolve(null);
      }
    };

    (window as unknown as { __halePlacesReady?: () => void }).__halePlacesReady = ready;

    const g = (window as unknown as { google?: MapsGlobal }).google;
    if (g?.maps?.importLibrary) {
      ready();
      return;
    }
    try {
      injectBootstrap(apiKey);
    } catch {
      resolve(null);
    }
  });
  return loadPromise;
}
