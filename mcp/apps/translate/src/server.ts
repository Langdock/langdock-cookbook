import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { translateWithDeepL } from "./deepl/client.js";
import { encodeForDataAttr } from "./utils/encodeForDataAttr.js";
import { getTranslateHtml } from "./utils/getTranslateHtml.js";
import { safeJsonForHtml } from "./utils/safeJsonForHtml.js";

export const TRANSLATE_RESOURCE_URI = "ui://translate/panel";

export const UI_RESOURCE_META = {
  ui: {
    permissions: { clipboardWrite: {} },
  },
} as const;

// ---------------------------------------------------------------------------
// MCP Server Factory
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "translate-mcp-server",
    version: "1.0.0",
  });

  registerAppResource(
    server,
    TRANSLATE_RESOURCE_URI,
    TRANSLATE_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, _meta: UI_RESOURCE_META },
    async () => ({
      contents: [
        {
          uri: TRANSLATE_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getTranslateHtml(),
          _meta: UI_RESOURCE_META,
        },
      ],
    }),
  );

  // -------------------------------------------------------------------------
  // Tool: Translate Text (UI Tool) — DeepL translates, UI shows side-by-side.
  // -------------------------------------------------------------------------
  registerAppTool(
    server,
    "translate_text",
    {
      title: "Translate Text",
      description:
        "Translate text with the DeepL API and display a side-by-side panel " +
        "(original vs translation), similar to DeepL / Google Translate. " +
        "Pass the source text and target language only — DeepL detects the source " +
        "language when omitted and returns the translation. " +
        "Use this whenever the user asks to translate text. " +
        "Do NOT translate yourself; call this tool and let DeepL do the work.",
      inputSchema: {
        source_text: z
          .string()
          .describe("The text to translate."),
        target_language: z
          .string()
          .describe(
            "Target language as a DeepL code (DE, EN-US, FR, …) or common name (German, English, French).",
          ),
        source_language: z
          .string()
          .optional()
          .describe(
            "Optional source language (DeepL code or name). Omit to let DeepL auto-detect.",
          ),
        title: z
          .string()
          .optional()
          .describe("Title shown above the panel (default: 'Translation')."),
      },
      _meta: { ui: { resourceUri: TRANSLATE_RESOURCE_URI } },
    },
    async ({ source_text, target_language, source_language, title }) => {
      try {
        const result = await translateWithDeepL({
          text: source_text,
          targetLanguage: target_language,
          sourceLanguage: source_language,
        });

        const renderData = {
          title: title ?? "Translation",
          sourceText: source_text,
          translatedText: result.translatedText,
          sourceLanguage: result.sourceLanguageLabel,
          targetLanguage: result.targetLanguageLabel,
        };

        let html = await getTranslateHtml();
        html = html.replace(
          '<div class="translate-container">',
          `<div class="translate-container" data-schema="${encodeForDataAttr(renderData)}">`,
        );
        html = html.replace(
          "</head>",
          `<script>window.TRANSLATE_DATA = ${safeJsonForHtml(renderData)};</script></head>`,
        );

        return {
          content: [
            { type: "text", text: JSON.stringify(renderData) },
            {
              type: "resource",
              resource: {
                uri: TRANSLATE_RESOURCE_URI,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
                _meta: UI_RESOURCE_META,
              },
            },
          ],
          _meta: { "mcpui.dev/ui-initial-render-data": renderData },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
