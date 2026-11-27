// ---------------------------------------------------------------------------
// Small string helpers shared across layers
// ---------------------------------------------------------------------------

/**
 * True for a defined, non-empty string. Explicit replacement for the plain
 * truthiness check (`if (value)`) on optional / nullable strings.
 */
export function isNonEmpty(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}
