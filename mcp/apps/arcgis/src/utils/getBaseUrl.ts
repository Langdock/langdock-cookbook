export function getBaseUrl(): string {
  // Explicit override takes priority
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, "");
  }

  // Railway sets RAILWAY_PUBLIC_DOMAIN automatically
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }

  throw new Error(
    "Could not determine base URL. Set BASE_URL or deploy on Railway.",
  );
}
