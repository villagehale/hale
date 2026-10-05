export function parseModelMode(raw: string | undefined, context: string): 'current' | 'candidate' {
  const mode = raw?.trim() || 'current';
  if (mode === 'current' || mode === 'candidate') return mode;
  console.error({ mode }, `${context}: invalid model mode; using current`);
  return 'current';
}
