# Contributing

> **Scope (for now):** Contributions are currently limited to the **Langdock
> Solutions Engineering (SE) team**. External pull requests will not be merged
> at this stage. This may open up later — until then, please reach out to the SE
> team if you'd like a recipe added.

## Adding a recipe

1. **Pick the right home.** Group by protocol first (`mcp/`, `a2a/`), then by the
   problem the recipe solves (e.g. `mcp/authentication/`, `mcp/apps/`). Add a
   new problem folder if none fits.
2. **Keep it self-contained.** A recipe is a standalone, runnable project. It must
   not depend on files outside its own folder.
3. **One problem per recipe.** Show a single pattern clearly rather than many at once.

## Recipe folder skeleton

```
my-recipe/
├── README.md          # required — see below
├── .env.example       # if the recipe needs configuration (never commit real secrets)
├── package.json
├── tsconfig.json
└── src/
```

## Recipe README checklist

Each recipe's `README.md` should cover, in order:

- **What it is** — one or two sentences naming the problem it solves.
- **Prerequisites** — accounts, API keys, runtimes, versions.
- **Setup & run** — exact commands (`pnpm install`, env setup, dev/build scripts).
- **How it works** — the key idea worth showcasing, not a line-by-line tour.

## Conventions

- **Stack:** TypeScript + Node.js, managed with **pnpm**, unless a recipe has a
  good reason to differ (document it in that recipe's README).
- **No secrets in git.** Provide a `.env.example`; keep real `.env` files ignored.
- **Index it.** Add the recipe to the table in the root [`README.md`](README.md)
  and the relevant section README (e.g. [`mcp/README.md`](mcp/README.md)).
- **Attribution.** If you import an existing repo, keep its original `LICENSE`
  file in the recipe folder.
