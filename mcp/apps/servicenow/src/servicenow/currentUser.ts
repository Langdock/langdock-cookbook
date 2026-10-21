import { createHash } from "node:crypto";

import { type CurrentUser, getCurrentUser } from "./client.js";

const CACHE_MS = 30 * 60 * 1000;
const users = new Map<string, Promise<CurrentUser>>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Look up the ServiceNow user behind a bearer token. Failed lookups are retried. */
export function resolveCurrentUser(
  token: string,
  headers: Record<string, string>,
): Promise<CurrentUser> {
  const tokenHash = hashToken(token);
  let user = users.get(tokenHash);
  if (!user) {
    user = getCurrentUser(token, headers);
    users.set(tokenHash, user);
    const timer = setTimeout(() => users.delete(tokenHash), CACHE_MS);
    timer.unref();
    user.catch(() => {
      clearTimeout(timer);
      users.delete(tokenHash);
    });
  }
  return user;
}
