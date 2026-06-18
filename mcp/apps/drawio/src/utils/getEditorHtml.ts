import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedEditorHtml: string | null = null;

export async function getEditorHtml(): Promise<string> {
  if (!cachedEditorHtml) {
    cachedEditorHtml = await fs.readFile(
      path.join(__dirname, "../ui", "editor.html"),
      "utf-8",
    );
  }
  return cachedEditorHtml;
}
