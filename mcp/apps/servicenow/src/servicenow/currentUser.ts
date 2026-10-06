import { createHash } from "node:crypto";

import { type CurrentUser, getCurrentUser } from "./client.js";

const CACHE_MS = 30 * 60 * 1000;
const users = new Map<string, Promise<CurrentUser>>();
const owners = new Map<string, Promise<string>>();

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

/**
 * Identify the owner of tasks and Otto conversations. Keying by user rather
 * than by token keeps them reachable after the client refreshes its token. If
 * the user lookup fails, the token itself becomes the owner.
 */
export function resolveTaskOwner(
  token: string,
  headers: Record<string, string>,
): Promise<string> {
  const tokenHash = hashToken(token);
  let owner = owners.get(tokenHash);
  if (!owner) {
    owner = resolveCurrentUser(token, headers).then(
      (user) => `user:${user.sysId}`,
      () => `token:${tokenHash}`,
    );
    owners.set(tokenHash, owner);
    setTimeout(() => owners.delete(tokenHash), CACHE_MS).unref();
  }
  return owner;
}
