import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedTicketHtml: string | null = null;

export async function getTicketHtml(): Promise<string> {
  if (!cachedTicketHtml) {
    cachedTicketHtml = await fs.readFile(
      path.join(__dirname, "../ui", "ticket.html"),
      "utf-8",
    );
  }
  return cachedTicketHtml;
}
