/**
 * Translate non-Latin prompts to English and, when enabled, rewrite them
 * into a detailed image prompt. Never throws: a failure keeps the original text.
 * The Pollinations key is sent only as an Authorization header and is never
 * written into a URL, a log line, or the returned prompt.
 */

import { moderatePrompt } from "./moderation.js";

const TEXT_URL = "https://gen.pollinations.ai/text";
const DEFAULT_TEXT_MODEL = "openai/gpt-5-nano";
const PREP_TIMEOUT_MS = 8000;

const TRANSLATE_SYSTEM =
  "Translate to a concise English image prompt; output only the prompt; keep names like anime characters recognizable.";

const ENHANCE_SYSTEM =
  "Rewrite the user text into one detailed, high-quality English image prompt. If it is not English, translate it first. Keep the user's intent and recognizable names such as anime characters. Include subject details, visual style, lighting, and composition. End with these quality tags: highly detailed, sharp focus, high resolution. Output only the prompt, with no quotes or explanation.";

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

async function readBody(res) {
  const ctype = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!res.ok || ctype.includes("json")) {
    return "";
  }
  return text;
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

async function pollinationsText({ prompt, style, enhance, fetchImpl, signal, key }) {
  const system = enhance ? ENHANCE_SYSTEM : TRANSLATE_SYSTEM;
  const url = new URL(`${TEXT_URL}/${encodeURIComponent(userContent(prompt, style))}`);
  url.searchParams.set("model", textModel());
  url.searchParams.set("system", system);
  url.searchParams.set("temperature", "0.2");
  url.searchParams.set("seed", String(Math.floor(Math.random() * 1_000_000_000)));
  const href = url.toString();
  if (key && href.includes(key)) return "";
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "text/plain, application/json",
      Authorization: `Bearer ${key}`,
    },
    signal,
  });
  return cleanModelText(await readBody(res), key);
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
  if (left() < 250) return "";
  const google = await withTimeout((fetchFn, signal) => googleTranslate(prompt, fetchFn, signal, key), left(), fetchImpl);
  if (google) return google;
  if (!hasArabicLetters(prompt) || left() < 250) return "";
  return withTimeout((fetchFn, signal) => myMemoryTranslate(prompt, fetchFn, signal, key), left(), fetchImpl);
}

export async function prepareImagePrompt({
  prompt,
  style = "",
  enhance = true,
  fetchImpl = globalThis.fetch,
  timeoutMs = PREP_TIMEOUT_MS,
} = {}) {
  const original = String(prompt || "").trim();
  const fallback = { providerPrompt: stylePrompt(original, style), promptEn: null, source: "original" };
  if (!original || process.env.PROMPT_PREP === "off") return fallback;

  const nonLatin = hasNonLatinLetters(original);
  const wantEnhance = enhance !== false;
  if (!wantEnhance && !nonLatin) return fallback;

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
    if (rewritten) source = "pollinations";
  }

  if (!rewritten && nonLatin) {
    rewritten = await keylessTranslate(original, fetchImpl, deadline, key);
    if (rewritten) source = "keyless";
  }

  if (!rewritten) return fallback;
  const providerPrompt = source === "pollinations" && wantEnhance ? rewritten : stylePrompt(rewritten, style);
  return { providerPrompt, promptEn: rewritten, source };
}

export async function finalizePrompt(options) {
  const original = moderatePrompt(options?.prompt);
  if (!original.allowed) return { ok: false, moderation: original };
  const prepared = await prepareImagePrompt(options);
  const second = moderatePrompt(prepared.providerPrompt);
  if (!second.allowed) return { ok: false, moderation: second, prepared };
  return { ok: true, moderation: second, ...prepared };
}
