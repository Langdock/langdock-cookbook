import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedFormHtml: string | null = null;

export async function getFormHtml(): Promise<string> {
  if (!cachedFormHtml) {
    cachedFormHtml = await fs.readFile(
      path.join(__dirname, "../ui", "form.html"),
      "utf-8",
    );
  }
  return cachedFormHtml;
}
