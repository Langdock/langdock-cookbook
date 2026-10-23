# translate-mcp-server

An MCP (Model Context Protocol) server that translates text with the **DeepL API** and shows a **DeepL / Google Translate–style** side-by-side panel.

The model only needs to call `translate_text` with the source text and target language — DeepL does the translation (and source-language detection when omitted). No LLM-side translation.

Modeled on the [`drawio`](../drawio/) recipe: same MCP-App pattern (a UI tool returns an embedded HTML resource).

## Prerequisites

- Node.js 18+
- pnpm
- A [DeepL API](https://www.deepl.com/pro-api) key (Free or Pro)

## Setup

1. Install:

```bash
pnpm install
```

2. Configure:

```bash
cp .env.example .env
# set DEEPL_API_KEY=
```

3. Build and run (load `.env` yourself, or export the key):

```bash
export $(grep -v '^#' .env | xargs)   # or use your preferred env loader
pnpm dev
```

The server starts on port `3000` and exposes the MCP endpoint at `/mcp`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DEEPL_API_KEY` | Yes | DeepL Free (`…:fx` → `api-free.deepl.com`) or Pro API key |
| `PORT` | No | Port to listen on (default: `3000`) |

## Endpoints

| Endpoint | Description |
|---|---|
| `/mcp` | MCP endpoint (GET, POST, DELETE) — no OAuth |
| `/health` | Health check |

## MCP Tools

### `translate_text`

Call DeepL to translate `source_text` into `target_language`, then open the side-by-side UI.

**Parameters:**

- `source_text` (required) — text to translate
- `target_language` (required) — DeepL code (`DE`, `EN-US`, `FR`, …) or common name (`German`, `English`)
- `source_language` (optional) — omit for auto-detect
- `title` (optional) — header label (default: `Translation`)

## Resources

### `ui://translate/panel`

The translation UI: language chips, original vs translation panes, copy buttons.

## Client Configuration

```json
{
  "mcpServers": {
    "translate": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

For a deployed server, replace the URL with your public endpoint, e.g. `https://your-app.up.railway.app/mcp`.

## Deployment

Deploy the built `dist/` and run `pnpm start` behind any HTTPS host. Set `DEEPL_API_KEY` in the host’s environment. Free keys ending in `:fx` automatically use `https://api-free.deepl.com`.

## How it works

1. The user asks to translate something.
2. The LLM calls `translate_text` with the text and target language (no self-translation).
3. The server calls DeepL `/v2/translate` and embeds the result in the UI resource.
4. Langdock shows original vs translation side by side.

Document translation and a glossary-backed `@translate` skill can sit on top of this later (DeepL also supports document + glossary APIs).
