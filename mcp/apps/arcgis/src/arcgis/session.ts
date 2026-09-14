import { createHash } from "node:crypto";

import type { ArcgisMapSession } from "./webmap.js";

const sessions = new Map<string, ArcgisMapSession>();

const sessionKey = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export function getMapSession(token: string): ArcgisMapSession | undefined {
  if (!token) return undefined;
  return sessions.get(sessionKey(token));
}

export function saveMapSession(
  token: string,
  session: ArcgisMapSession,
): ArcgisMapSession {
  sessions.set(sessionKey(token), session);
  return session;
}

export function clearMapSession(token: string): void {
  sessions.delete(sessionKey(token));
}
