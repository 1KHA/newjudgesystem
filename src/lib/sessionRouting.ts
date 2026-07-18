/**
 * Validates/normalizes a session id coming from a URL param (/judge/:sessionId).
 * Returns the cleaned id, or null when the param is missing/invalid.
 * Kept pure (no Supabase/React) so it is unit-testable in Node.
 */
export function normalizeSessionParam(param: string | undefined | null): string | null {
  if (!param) return null;
  const trimmed = param.trim();
  // Session ids are generated via crypto.randomUUID().substring(0, 8)
  // but be permissive enough for legacy/custom ids.
  return /^[A-Za-z0-9_-]{4,64}$/.test(trimmed) ? trimmed : null;
}
