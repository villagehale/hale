export function textOfFetchSource(
  source:
    | {
        data?: string;
        type?: string;
        media_type?: string;
      }
    | null
    | undefined,
): string;

export function textFromPdf(bytes: Uint8Array): string;
