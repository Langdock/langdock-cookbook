/**
 * Serialize data to JSON safe for embedding in a <script> tag.
 * Escapes characters that could break out of a script context, including the
 * U+2028 / U+2029 line/paragraph separators that are valid JSON but illegal
 * in a JS string literal.
 */
export function safeJsonForHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/'/g, "\\u0027")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}
