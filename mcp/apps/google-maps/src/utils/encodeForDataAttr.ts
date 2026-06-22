/**
 * Serialize data to JSON safe for embedding in an HTML data attribute.
 */
export function encodeForDataAttr(data: unknown): string {
  return JSON.stringify(data)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
