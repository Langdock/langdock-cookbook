# Langdock Cookbook

Self-contained recipes for recurring problems when building on Langdock. Each
recipe is a small, runnable project that solves one problem and explains how.

- **[MCP recipes](mcp/)** — authentication (OAuth + DCR), interactive UI, file uploads
- **[A2A recipes](a2a/)** — agents on the A2A protocol

Each section's README lists its recipes; each recipe folder is standalone with
its own README.

## Using a recipe

Clone the repo (or copy a single folder) and work inside that folder. All current
recipes are **TypeScript + Node.js**, managed with **pnpm**:

```bash
cd mcp/authentication/okta-dcr   # any recipe folder
pnpm install
cp .env.example .env             # where applicable
pnpm dev                         # see the recipe's README for exact scripts
```

---

Maintained by the Langdock Solutions Engineering team — see
[CONTRIBUTING.md](CONTRIBUTING.md). Licensed [MIT](LICENSE) (imported recipes may
keep their own `LICENSE` for attribution).
