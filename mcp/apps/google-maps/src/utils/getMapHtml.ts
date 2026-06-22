import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedMapHtml: string | null = null;

export async function getMapHtml(): Promise<string> {
  if (!cachedMapHtml) {
    cachedMapHtml = await fs.readFile(
      path.join(__dirname, "../ui", "map.html"),
      "utf-8",
    );
  }
  return cachedMapHtml;
}
