/**
 * Translate non-Latin prompts to English and, when enabled, rewrite them
 * into a detailed image prompt. Never throws: a failure keeps the original text.
 * The Pollinations key is sent only as an Authorization header and is never
 * written into a URL, a log line, or the returned prompt.
 */

import { moderatePrompt } from "./moderation.js";

const TEXT_URL = "https://gen.pollinations.ai/text";
// Alias on gen.pollinations.ai/text/models for openai/gpt-5.4-nano. Survives id renames.
const DEFAULT_TEXT_MODEL = "openai";
// Alias for openai/gpt-5-nano, paid_only false. Used once if the first model is not 2xx.
const FALLBACK_TEXT_MODEL = "openai-fast";
const PREP_TIMEOUT_MS = 8000;
const QUALITY_SUFFIX = ", highly detailed, sharp focus, high resolution";

const TRANSLATE_SYSTEM =
  "Translate to a concise English image prompt; output only the prompt; keep names like anime characters recognizable.";

const ENHANCE_SYSTEM =
  "Rewrite the user text into one detailed, high-quality English image prompt. If it is not English, translate it first. Keep the user's intent and recognizable names. If the subject is a known anime, cartoon, or game character, explicitly add the franchise name, the art style (for example: anime style, Masashi Kishimoto art style), and the character's signature visual traits (outfit, hair color, eyes) so the image model draws them correctly. If two characters are fighting, describe both characters and the action. Include subject details, visual style, lighting, and composition. End with these quality tags: highly detailed, sharp focus, high resolution. Output only the prompt, with no quotes or explanation.";

export function hasNonLatinLetters(text) {
  for (const ch of String(text || "")) {
    if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) return true;
  }
  return false;
}

export function hasArabicLetters(text) {
  return /\p{Script=Arabic}/u.test(String(text || ""));
}

function apiKey() {
  return String(process.env.POLLINATIONS_API_KEY || "").trim();
}

function textModel() {
  return String(process.env.POLLINATIONS_TEXT_MODEL || DEFAULT_TEXT_MODEL).trim() || DEFAULT_TEXT_MODEL;
}

function modelAttempts() {
  const primary = textModel();
  if (primary === FALLBACK_TEXT_MODEL) return [primary];
  return [primary, FALLBACK_TEXT_MODEL];
}

function logPrepPath(source) {
  const pathName = source === "llm" || source === "gtx" || source === "mymemory" || source === "original" ? source : "original";
  console.log(`prompt-prep path=${pathName}`);
}

function withQualitySuffix(text) {
  const base = String(text || "").trim();
  if (!base) return "";
  if (/highly detailed,\s*sharp focus,\s*high resolution/i.test(base)) return base;
  return `${base}${QUALITY_SUFFIX}`;
}

function redact(text, key = apiKey()) {
  const raw = String(text || "");
  if (!key) return raw;
  return raw.split(key).join("");
}

function stylePrompt(prompt, style) {
  const s = String(style || "").trim();
  if (!s) return prompt;
  return `${prompt}\n\nArt style: ${s}.`;
}

function cleanModelText(text, key) {
  let out = redact(text, key).replace(/\s+/g, " ").trim();
  out = out.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("「") && out.endsWith("」"))) {
    out = out.slice(1, -1).trim();
  }
  out = out.replace(/^(prompt|image prompt)\s*:\s*/i, "").trim();
  if (out.length > 1800) out = out.slice(0, 1800).trim();
  if (!out || (key && out.includes(key))) return "";
  return out;
}

function userContent(prompt, style) {
  const styleLine = String(style || "").trim() ? `Selected style: ${String(style).trim()}\n` : "";
  return `${styleLine}User prompt:\n${prompt}`;
}

async function withTimeout(work, ms, fetchImpl) {
  const timeout = Math.max(1, ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const task = Promise.resolve()
    .then(() => work(fetchImpl, controller.signal))
    .then((value) => value || "")
    .catch(() => "");
  try {
    return await Promise.race([
      task,
      new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(""), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function pollinationsTextOnce({ prompt, style, enhance, fetchImpl, signal, key, model }) {
  const system = enhance ? ENHANCE_SYSTEM : TRANSLATE_SYSTEM;
  const url = new URL(`${TEXT_URL}/${encodeURIComponent(userContent(prompt, style))}`);
  url.searchParams.set("model", model);
  url.searchParams.set("system", system);
  url.searchParams.set("temperature", "0.2");
  url.searchParams.set("seed", String(Math.floor(Math.random() * 1_000_000_000)));
  const href = url.toString();
  if (key && href.includes(key)) return { ok: false, text: "" };
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "text/plain, application/json",
      Authorization: `Bearer ${key}`,
    },
    signal,
  });
  if (!res.ok) return { ok: false, text: "" };
  const ctype = res.headers.get("content-type") || "";
  const raw = await res.text();
  if (ctype.includes("json")) return { ok: true, text: "" };
  return { ok: true, text: cleanModelText(raw, key) };
}

async function pollinationsText(args) {
  const models = modelAttempts();
  for (let i = 0; i < models.length; i += 1) {
    const result = await pollinationsTextOnce({ ...args, model: models[i] });
    if (result.ok) return result.text;
    if (i === models.length - 1) return "";
  }
  return "";
}

function joinGoogle(data) {
  const rows = Array.isArray(data?.[0]) ? data[0] : [];
  return rows.map((part) => (Array.isArray(part) ? part[0] : "")).join("");
}

async function googleTranslate(prompt, fetchImpl, signal, key) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", "en");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", prompt);
  const res = await fetchImpl(url, { signal });
  if (!res.ok) return "";
  const data = await res.json();
  return cleanModelText(joinGoogle(data), key);
}

async function myMemoryTranslate(prompt, fetchImpl, signal, key) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", prompt.slice(0, 450));
  url.searchParams.set("langpair", "ar|en");
  const res = await fetchImpl(url, { signal });
  if (!res.ok) return "";
  const data = await res.json();
  const text = data?.responseData?.translatedText || "";
  if (/MYMEMORY WARNING/i.test(text) || /INVALID/i.test(text)) return "";
  return cleanModelText(text, key);
}

async function keylessTranslate(prompt, fetchImpl, deadline, key) {
  const left = () => deadline - Date.now();
  if (left() < 250) return { text: "", source: "" };
  const google = await withTimeout((fetchFn, signal) => googleTranslate(prompt, fetchFn, signal, key), left(), fetchImpl);
  if (google) return { text: google, source: "gtx" };
  if (!hasArabicLetters(prompt) || left() < 250) return { text: "", source: "" };
  const memory = await withTimeout((fetchFn, signal) => myMemoryTranslate(prompt, fetchFn, signal, key), left(), fetchImpl);
  if (memory) return { text: memory, source: "mymemory" };
  return { text: "", source: "" };
}

export async function prepareImagePrompt({
  prompt,
  style = "",
  enhance = true,
  fetchImpl = globalThis.fetch,
  timeoutMs = PREP_TIMEOUT_MS,
} = {}) {
  const original = String(prompt || "").trim();
  const finish = (result) => {
    logPrepPath(result.source);
    return result;
  };
  const fallback = { providerPrompt: stylePrompt(original, style), promptEn: null, source: "original" };
  if (!original || process.env.PROMPT_PREP === "off") return finish(fallback);

  const nonLatin = hasNonLatinLetters(original);
  const wantEnhance = enhance !== false;
  if (!wantEnhance && !nonLatin) return finish(fallback);

  const key = apiKey();
  const deadline = Date.now() + timeoutMs;
  let rewritten = "";
  let source = "";

  if (key && deadline - Date.now() > 250) {
    rewritten = await withTimeout(
      (fetchFn, signal) => pollinationsText({
        prompt: original,
        style,
        enhance: wantEnhance,
        fetchImpl: fetchFn,
        signal,
        key,
      }),
      deadline - Date.now(),
      fetchImpl,
    );
    if (rewritten) source = "llm";
  }

  if (!rewritten && nonLatin) {
    const translated = await keylessTranslate(original, fetchImpl, deadline, key);
    if (translated.text) {
      rewritten = translated.text;
      source = translated.source;
    }
  }

  if (!rewritten) return finish(fallback);
  const shown = wantEnhance && (source === "gtx" || source === "mymemory") ? withQualitySuffix(rewritten) : rewritten;
  const providerPrompt = source === "llm" && wantEnhance ? shown : stylePrompt(shown, style);
  return finish({ providerPrompt, promptEn: shown, source });
}

export async function finalizePrompt(options) {
  const original = moderatePrompt(options?.prompt);
  if (!original.allowed) return { ok: false, moderation: original };
  const prepared = await prepareImagePrompt(options);
  const second = moderatePrompt(prepared.providerPrompt);
  if (!second.allowed) return { ok: false, moderation: second, prepared };
  return { ok: true, moderation: second, ...prepared };
}
