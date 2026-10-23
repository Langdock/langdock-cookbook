import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
  // Tool: Translate Text (UI Tool) — side-by-side original vs translation.
  // The LLM performs the translation; this tool only displays the result.
  // -------------------------------------------------------------------------
  registerAppTool(
    server,
    "translate_text",
    {
      title: "Translate Text",
      description:
        "Display a side-by-side translation panel (original language vs target language), " +
        "similar to Google Translate or DeepL. " +
        "YOU perform the translation yourself — detect the source language if needed, " +
        "translate the text into the target language, then call this tool with BOTH the " +
        "original text and your translation so the user can compare them. " +
        "Use this whenever the user asks to translate text, show a translation, or " +
        "compare original and translated wording. " +
        "Do not invent a translation API; your model output is the translation.",
      inputSchema: {
        source_text: z
          .string()
          .describe("The original text in the source language."),
        translated_text: z
          .string()
          .describe("Your translation of source_text into the target language."),
        source_language: z
          .string()
          .describe(
            "Detected or stated source language name, e.g. 'English', 'German', 'French'. " +
              "Use 'auto' only if you truly cannot tell.",
          ),
        target_language: z
          .string()
          .describe("Target language name, e.g. 'German', 'Spanish', 'Japanese'."),
        title: z
          .string()
          .optional()
          .describe("Title shown above the panel (default: 'Translation')."),
      },
      _meta: { ui: { resourceUri: TRANSLATE_RESOURCE_URI } },
    },
    async ({
      source_text,
      translated_text,
      source_language,
      target_language,
      title,
    }) => {
      try {
        const renderData = {
          title: title ?? "Translation",
          sourceText: source_text,
          translatedText: translated_text,
          sourceLanguage: source_language,
          targetLanguage: target_language,
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
          // First content item is the render data as JSON — matching draw.io /
          // google-maps so the Langdock host renders the UI inline.
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
