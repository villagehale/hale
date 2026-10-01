type FallbackCategory =
  | 'low_confidence'
  | 'missing_key'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_response'
  | 'provider_error';

const counts = new Map<string, number>();

export function modelErrorCategory(error: unknown): FallbackCategory {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error) {
    if (/api.key.+not set/i.test(error.message)) return 'missing_key';
    if (/invalid choice|parse|schema|validation/i.test(error.message)) return 'invalid_response';
  }
  const status = (error as { status?: unknown })?.status;
  return status === 429 ? 'rate_limited' : 'provider_error';
}

export function recordModelFallback(
  stage: string,
  errorOrCategory: unknown | FallbackCategory,
): void {
  const category =
    typeof errorOrCategory === 'string' ? errorOrCategory : modelErrorCategory(errorOrCategory);
  const fallbackCount = (counts.get(stage) ?? 0) + 1;
  counts.set(stage, fallbackCount);
  console.warn({ errorCategory: category, fallbackCount }, `${stage}: using current model`);
}
