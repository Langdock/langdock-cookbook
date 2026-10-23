# translate-mcp-server

An MCP (Model Context Protocol) server that shows a **DeepL / Google Translate–style** side-by-side panel for text translations.

The **LLM performs the translation**. This server only renders the result: original language on the left, target language on the right, with copy buttons. No translation API keys and no OAuth.

Modeled on the [`drawio`](../drawio/) recipe: same MCP-App pattern (a UI tool returns an embedded interactive HTML resource), keyless and fully display-side.

## Prerequisites

- Node.js 18+
- pnpm

## Setup

1. Install:

```bash
pnpm install
```

2. Build and run:

```bash
pnpm dev
```

The server starts on port `3000` and exposes the MCP endpoint at `/mcp`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default: `3000`) |

## Endpoints

| Endpoint | Description |
|---|---|
| `/mcp` | MCP endpoint (GET, POST, DELETE) — no auth required |
| `/health` | Health check |

## MCP Tools

### `translate_text`

Display a side-by-side translation panel. The model should detect the source language (if needed), translate the text itself, then call this tool with **both** the original and the translation.

**Parameters:**

- `source_text` (required) — original text
- `translated_text` (required) — model-produced translation
- `source_language` (required) — detected or stated source language (e.g. `English`)
- `target_language` (required) — target language (e.g. `German`)
- `title` (optional) — header label (default: `Translation`)

## Resources

### `ui://translate/panel`

The translation UI rendered by `translate_text`: language chips, original vs translation panes, and copy-to-clipboard actions.

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

The server is stateless and keyless — deploy the built `dist/` and run `pnpm start` behind any HTTPS host (Railway, Fly, etc.). The only configuration is the optional `PORT`.

## How it works

1. The user asks to translate something.
2. The LLM detects the source language (if needed) and writes the translation.
3. The LLM calls `translate_text` with original text, translation, and both language labels.
4. Langdock embeds the HTML resource so the user can compare and copy.

Document translation and a glossary-backed `@translate` skill are out of scope for this recipe; they can sit on top of the same UI tool later.
