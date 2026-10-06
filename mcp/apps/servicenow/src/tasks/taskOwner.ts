import { createHash } from "node:crypto";

import { getCurrentUser } from "../servicenow/client.js";

const OWNER_CACHE_MS = 30 * 60 * 1000;
const owners = new Map<string, Promise<string>>();

/**
 * Identify the ServiceNow user behind a bearer token. Keying tasks by user
 * rather than by token keeps them reachable after the client refreshes its
 * token. If the user lookup fails, the token itself becomes the owner.
 */
export function resolveTaskOwner(
  token: string,
  headers: Record<string, string>,
): Promise<string> {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  let owner = owners.get(tokenHash);
  if (!owner) {
    owner = getCurrentUser(token, headers).then(
      (user) => `user:${user.sysId}`,
      () => `token:${tokenHash}`,
    );
    owners.set(tokenHash, owner);
    setTimeout(() => owners.delete(tokenHash), OWNER_CACHE_MS).unref();
  }
  return owner;
}
