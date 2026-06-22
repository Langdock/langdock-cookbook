/**
 * Get the ServiceNow instance URL from environment variable.
 * Supports both subdomain (e.g., "dev12345") and full hostname (e.g., "dev12345.service-now.com").
 */
export function getInstanceUrl(): string {
  const instance = process.env.SERVICENOW_INSTANCE;
  if (!instance) {
    throw new Error("SERVICENOW_INSTANCE environment variable is required");
  }
  const host = instance.includes(".")
    ? instance
    : `${instance}.service-now.com`;
  return `https://${host}`;
}
