/**
 * Loads Google Maps JS libraries on the client, on demand, behind ONE shared
 * bootstrap. `loadPlacesAutocomplete` returns the `PlaceAutocompleteElement`
 * constructor (onboarding address entry); `loadMapsLibrary` returns the `Map` +
 * `marker` constructors (the village map). Both degrade to null if the API key is
 * absent or the script fails to load — the caller falls back gracefully (manual
 * address entry / no map). We never log the key or any address (rule #1).
 *
 * The bootstrap loader is injected at most once per page and memoised, so every
 * caller (multiple address fields, the village map) shares a single script + a
 * single in-flight load.
 */

type PlaceAutocompleteElementCtor = new (options: {
  includedRegionCodes?: string[];
}) => HTMLElement;

interface MapsImportLibrary {
  (name: 'places'): Promise<{ PlaceAutocompleteElement?: PlaceAutocompleteElementCtor }>;
  (name: 'maps'): Promise<{ Map?: unknown }>;
  (name: 'marker'): Promise<{ AdvancedMarkerElement?: unknown; PinElement?: unknown }>;
  (name: 'core'): Promise<{ LatLngBounds?: unknown }>;
  (name: string): Promise<unknown>;
}

interface MapsGlobal {
  maps?: {
    importLibrary?: MapsImportLibrary;
  };
}

/** Resolves to the Maps JS `importLibrary`, or null if the key/script is absent. */
export interface MapsLibraries {
  Map: new (el: HTMLElement, opts: unknown) => unknown;
  AdvancedMarkerElement: new (opts: unknown) => unknown;
  PinElement: new (opts: unknown) => { element: HTMLElement };
  LatLngBounds: new () => { extend: (p: unknown) => void };
}

let bootstrapPromise: Promise<MapsImportLibrary | null> | null = null;

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

/**
 * The single shared loader: resolves to the Maps `importLibrary` once the script
 * is ready, or null when the key is absent / the script fails. Memoised so every
 * caller shares one script + one in-flight load.
 */
function whenMapsReady(): Promise<MapsImportLibrary | null> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }
  bootstrapPromise = new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(null);
      return;
    }
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      resolve(null);
      return;
    }

    const ready = () => {
      const importLibrary = (window as unknown as { google?: MapsGlobal }).google?.maps
        ?.importLibrary;
      resolve(importLibrary ?? null);
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
  return bootstrapPromise;
}

export async function loadPlacesAutocomplete(): Promise<PlaceAutocompleteElementCtor | null> {
  const importLibrary = await whenMapsReady();
  if (!importLibrary) return null;
  try {
    const lib = await importLibrary('places');
    return lib.PlaceAutocompleteElement ?? null;
  } catch {
    return null;
  }
}

/**
 * Loads the `maps` + `marker` libraries for the village map, or null if the key /
 * script is unavailable (the caller renders the list-only fallback). Reuses the
 * same shared bootstrap as the address autocomplete — one script, one key.
 */
export async function loadMapsLibrary(): Promise<MapsLibraries | null> {
  const importLibrary = await whenMapsReady();
  if (!importLibrary) return null;
  try {
    const [mapsLib, markerLib, coreLib] = await Promise.all([
      importLibrary('maps') as Promise<{ Map?: unknown }>,
      importLibrary('marker') as Promise<{ AdvancedMarkerElement?: unknown; PinElement?: unknown }>,
      // LatLngBounds is in the 'core' library, NOT 'maps' — importing it from
      // 'maps' yielded undefined and silently nulled the whole map.
      importLibrary('core') as Promise<{ LatLngBounds?: unknown }>,
    ]);
    if (
      !mapsLib.Map ||
      !coreLib.LatLngBounds ||
      !markerLib.AdvancedMarkerElement ||
      !markerLib.PinElement
    ) {
      return null;
    }
    return {
      Map: mapsLib.Map as MapsLibraries['Map'],
      LatLngBounds: coreLib.LatLngBounds as MapsLibraries['LatLngBounds'],
      AdvancedMarkerElement: markerLib.AdvancedMarkerElement as MapsLibraries['AdvancedMarkerElement'],
      PinElement: markerLib.PinElement as MapsLibraries['PinElement'],
    };
  } catch {
    return null;
  }
}
