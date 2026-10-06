import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withOttoChat } from "./withOttoChat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedTicketListHtml: string | null = null;

export async function getTicketListHtml(): Promise<string> {
  if (!cachedTicketListHtml) {
    cachedTicketListHtml = await withOttoChat(
      await fs.readFile(path.join(__dirname, "../ui", "ticket-list.html"), "utf-8"),
    );
  }
  return cachedTicketListHtml;
}
