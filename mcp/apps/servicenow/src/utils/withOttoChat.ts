import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedFragment: string | null = null;

/** Inline the shared Otto chat module where a page has the placeholder. */
export async function withOttoChat(html: string): Promise<string> {
  if (!cachedFragment) {
    cachedFragment = await fs.readFile(
      path.join(__dirname, "../ui", "otto-chat.html"),
      "utf-8",
    );
  }
  const fragment = cachedFragment;
  return html.replace("<!-- otto-chat -->", () => fragment);
}
