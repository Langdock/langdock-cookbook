import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedTranslateHtml: string | null = null;

export async function getTranslateHtml(): Promise<string> {
  if (!cachedTranslateHtml) {
    cachedTranslateHtml = await fs.readFile(
      path.join(__dirname, "../ui", "translate.html"),
      "utf-8",
    );
  }
  return cachedTranslateHtml;
}
