/**
 * Minimal DeepL Translate API client.
 * Free keys end with `:fx` and use api-free.deepl.com; Pro uses api.deepl.com.
 */

const LANG_ALIASES: Record<string, string> = {
  auto: "",
  english: "EN",
  en: "EN",
  "en-us": "EN-US",
  "en-gb": "EN-GB",
  german: "DE",
  deutsch: "DE",
  de: "DE",
  french: "FR",
  français: "FR",
  francais: "FR",
  fr: "FR",
  spanish: "ES",
  español: "ES",
  espanol: "ES",
  es: "ES",
  italian: "IT",
  italiano: "IT",
  it: "IT",
  portuguese: "PT-PT",
  portugese: "PT-PT",
  "portuguese (brazil)": "PT-BR",
  "portuguese (portugal)": "PT-PT",
  "pt-br": "PT-BR",
  "pt-pt": "PT-PT",
  pt: "PT-PT",
  dutch: "NL",
  nederlands: "NL",
  nl: "NL",
  polish: "PL",
  pl: "PL",
  russian: "RU",
  ru: "RU",
  japanese: "JA",
  ja: "JA",
  chinese: "ZH",
  "chinese (simplified)": "ZH-HANS",
  "zh-hans": "ZH-HANS",
  "zh-hant": "ZH-HANT",
  zh: "ZH",
  korean: "KO",
  ko: "KO",
  swedish: "SV",
  sv: "SV",
  danish: "DA",
  da: "DA",
  finnish: "FI",
  fi: "FI",
  norwegian: "NB",
  nb: "NB",
  czech: "CS",
  cs: "CS",
  hungarian: "HU",
  hu: "HU",
  romanian: "RO",
  ro: "RO",
  slovak: "SK",
  sk: "SK",
  slovenian: "SL",
  sl: "SL",
  bulgarian: "BG",
  bg: "BG",
  greek: "EL",
  el: "EL",
  estonian: "ET",
  et: "ET",
  latvian: "LV",
  lv: "LV",
  lithuanian: "LT",
  lt: "LT",
  indonesian: "ID",
  id: "ID",
  turkish: "TR",
  tr: "TR",
  ukrainian: "UK",
  uk: "UK",
  arabic: "AR",
  ar: "AR",
};

const LANG_LABELS: Record<string, string> = {
  EN: "English",
  "EN-US": "English (US)",
  "EN-GB": "English (UK)",
  DE: "German",
  FR: "French",
  ES: "Spanish",
  IT: "Italian",
  "PT-PT": "Portuguese",
  "PT-BR": "Portuguese (Brazil)",
  NL: "Dutch",
  PL: "Polish",
  RU: "Russian",
  JA: "Japanese",
  ZH: "Chinese",
  "ZH-HANS": "Chinese (Simplified)",
  "ZH-HANT": "Chinese (Traditional)",
  KO: "Korean",
  SV: "Swedish",
  DA: "Danish",
  FI: "Finnish",
  NB: "Norwegian",
  CS: "Czech",
  HU: "Hungarian",
  RO: "Romanian",
  SK: "Slovak",
  SL: "Slovenian",
  BG: "Bulgarian",
  EL: "Greek",
  ET: "Estonian",
  LV: "Latvian",
  LT: "Lithuanian",
  ID: "Indonesian",
  TR: "Turkish",
  UK: "Ukrainian",
  AR: "Arabic",
};

export type DeepLTranslateResult = {
  translatedText: string;
  detectedSourceLanguage: string;
  sourceLanguageLabel: string;
  targetLanguageLabel: string;
  targetLangCode: string;
};

export function languageLabel(code: string): string {
  const upper = code.toUpperCase();
  return LANG_LABELS[upper] ?? upper;
}

/** Normalize a human language name or DeepL code to a DeepL language code. */
export function toDeepLLangCode(
  input: string,
  kind: "source" | "target",
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(`${kind} language is required`);
  }

  const key = trimmed.toLowerCase();
  if (key in LANG_ALIASES) {
    const mapped = LANG_ALIASES[key];
    if (kind === "source" && mapped === "") return "";
    if (kind === "target" && mapped === "") {
      throw new Error("target language cannot be auto");
    }
    // Source EN is plain EN; target EN needs a variant — default EN-US.
    if (kind === "target" && mapped === "EN") return "EN-US";
    return mapped;
  }

  // Already a DeepL-style code (DE, EN-US, ZH-HANS, …)
  const asCode = trimmed.toUpperCase();
  if (/^[A-Z]{2}(-[A-Z0-9]+)?$/.test(asCode)) {
    if (kind === "target" && asCode === "EN") return "EN-US";
    return asCode;
  }

  throw new Error(
    `Unsupported ${kind} language "${input}". Use a DeepL code (e.g. DE, EN-US, FR) or a common name (German, English).`,
  );
}

function apiBaseUrl(authKey: string): string {
  return authKey.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com";
}

export async function translateWithDeepL(options: {
  text: string;
  targetLanguage: string;
  sourceLanguage?: string;
  authKey?: string;
}): Promise<DeepLTranslateResult> {
  const authKey = options.authKey ?? process.env.DEEPL_API_KEY;
  if (!authKey) {
    throw new Error(
      "DEEPL_API_KEY is not set. Add it to the environment (DeepL Free or Pro API key).",
    );
  }

  const targetLang = toDeepLLangCode(options.targetLanguage, "target");
  const sourceLang = options.sourceLanguage
    ? toDeepLLangCode(options.sourceLanguage, "source")
    : "";

  const body: Record<string, unknown> = {
    text: [options.text],
    target_lang: targetLang,
  };
  if (sourceLang) {
    body.source_lang = sourceLang;
  }

  const res = await fetch(`${apiBaseUrl(authKey)}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${authKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const traceId = res.headers.get("x-trace-id") ?? undefined;
  const raw = await res.text();

  if (!res.ok) {
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // keep raw
    }
    const suffix = traceId ? ` (trace ${traceId})` : "";
    throw new Error(`DeepL API ${res.status}: ${message}${suffix}`);
  }

  const data = JSON.parse(raw) as {
    translations: Array<{
      detected_source_language: string;
      text: string;
    }>;
  };

  const first = data.translations?.[0];
  if (!first) {
    throw new Error("DeepL returned no translations");
  }

  const detected = first.detected_source_language || sourceLang || "UNKNOWN";

  return {
    translatedText: first.text,
    detectedSourceLanguage: detected,
    sourceLanguageLabel: languageLabel(detected),
    targetLanguageLabel: languageLabel(targetLang),
    targetLangCode: targetLang,
  };
}
