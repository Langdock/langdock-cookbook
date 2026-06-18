import type { IncomingHttpHeaders } from "node:http";

/**
 * Extracts custom headers (x- prefix) from an incoming request.
 * These are forwarded to downstream API calls.
 */
export function extractCustomHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => key.startsWith("x-"))
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? value[0] : (value ?? ""),
      ]),
  );
}
