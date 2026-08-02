export function getBaseUrl(): string {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "BASE_URL environment variable is required (e.g., https://mcp.example.com)",
    );
  }
  return baseUrl.replace(/\/$/, "");
}
