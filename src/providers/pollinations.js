/**
 * Pollinations image provider.
 *
 * Without POLLINATIONS_API_KEY: classic keyless route
 *   GET https://image.pollinations.ai/prompt/{prompt}?width&height&seed&safe
 *   one image, about 45s apart, longest edge 1024.
 *
 * With POLLINATIONS_API_KEY: authenticated route
 *   GET https://gen.pollinations.ai/image/{prompt}
 *   Authorization: Bearer <key>   (the key is never placed in the URL)
 *   model=flux by default (free). POLLINATIONS_MODEL may only select that free model.
 *   Docs: https://gen.pollinations.ai/docs
 *   width/height up to 1024 (flux pixel cap is about 1 megapixel).
 *   The API accepts one image per GET, so several images are several requests.
 */

const CLASSIC_BASE = "https://image.pollinations.ai/prompt";
const GEN_BASE = "https://gen.pollinations.ai/image";
const CLASSIC_MAX_EDGE = 1024;
const KEYED_MAX_EDGE = 1024;
const DEFAULT_MODEL = "flux";
const FREE_MODELS = new Set(["flux", "black-forest-labs/flux.1-schnell"]);

const RATIOS = {
  "1:1": [1, 1],
  "16:9": [16, 9],
  "9:16": [9, 16],
  "3:2": [3, 2],
  "2:3": [2, 3],
  "4:3": [4, 3],
  "3:4": [3, 4],
};

export function pollinationsApiKey() {
  return String(process.env.POLLINATIONS_API_KEY || "").trim();
}

export function pollinationsModel() {
  const requested = String(process.env.POLLINATIONS_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  if (!FREE_MODELS.has(requested)) {
    const err = new Error("يُستخدم النموذج المجاني flux فقط. لا يُختار نموذج مدفوع.");
    err.code = "not_configured";
    throw err;
  }
  return requested;
}

export function pollinationsSize(aspectRatio, { keyed = false } = {}) {
  const maxEdge = keyed ? KEYED_MAX_EDGE : CLASSIC_MAX_EDGE;
  const [rw, rh] = RATIOS[aspectRatio] || [1, 1];
  const scale = Math.min(maxEdge / rw, maxEdge / rh);
  let width = Math.max(1, Math.round(rw * scale));
  let height = Math.max(1, Math.round(rh * scale));
  if (keyed) {
    width = Math.min(KEYED_MAX_EDGE, Math.max(64, Math.round(width / 8) * 8));
    height = Math.min(KEYED_MAX_EDGE, Math.max(64, Math.round(height / 8) * 8));
  }
  return { width, height };
}

function parseRetryAfter(res) {
  const raw = res.headers.get("retry-after") || res.headers.get("Retry-After");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 45;
}

function redact(text, key) {
  const raw = String(text || "");
  if (!key) return raw;
  return raw.split(key).join("[redacted]");
}

async function readErrorMessage(res) {
  const ctype = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ctype.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      const data = JSON.parse(text);
      const nested = data.error && typeof data.error === "object" ? data.error.message || data.error.code : "";
      return data.message || nested || (typeof data.error === "string" ? data.error : "") || data.code || text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  }
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function looksLikeJson(buffer) {
  const text = buffer.subarray(0, 32).toString("utf8").trimStart();
  return text.startsWith("{") || text.startsWith("[");
}

function providerError(status, detail, key) {
  const safe = redact(detail, key);
  let message = safe;
  if (status === 401) message = "مفتاح Pollinations مرفوض. تحقق من POLLINATIONS_API_KEY على الخادم.";
  else if (status === 402) message = safe || "رصيد مفتاح Pollinations غير كافٍ أو تجاوز حد الاستخدام.";
  else if (!message) message = `رفض مزود الصور الطلب (رمز ${status}).`;
  const err = new Error(redact(message, key));
  err.code = status === 401 || status === 402 ? (status === 401 ? "not_configured" : "rate_limit") : status === 400 || status === 422 ? "provider_rejected" : "provider";
  err.status = status;
  return err;
}

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000);
}

async function requestImage({ prompt, aspectRatio, key, enhance }) {
  const keyed = Boolean(key);
  const { width, height } = pollinationsSize(aspectRatio, { keyed: keyed || Boolean(enhance) });
  const seed = randomSeed();
  const base = keyed ? GEN_BASE : CLASSIC_BASE;
  const url = new URL(`${base}/${encodeURIComponent(prompt)}`);
  url.searchParams.set("width", String(width));
  url.searchParams.set("height", String(height));
  url.searchParams.set("seed", String(seed));
  url.searchParams.set("safe", "true");
  // Classic image.pollinations.ai supports enhance=true. The gen image route
  // does not document it, so the query is sent only on the classic URL.
  if (enhance && !keyed) url.searchParams.set("enhance", "true");
  if (keyed) url.searchParams.set("model", pollinationsModel());

  if (key && url.toString().includes(key)) {
    const err = new Error("تعذر إنشاء الطلب بدون كشف المفتاح.");
    err.code = "not_configured";
    throw err;
  }

  const headers = {
    Accept: "image/jpeg,image/png,image/webp,image/*,application/json",
    "User-Agent": "ImageVideoStudio/1.0 (self-hosted free client)",
  };
  if (keyed) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(120000),
  });

  const ctype = res.headers.get("content-type") || "";
  const jsonBody = ctype.includes("json");
  if (!res.ok || jsonBody) {
    const detail = await readErrorMessage(res);
    if (res.status === 402 || res.status === 429) {
      const wait = parseRetryAfter(res);
      const err = providerError(res.status, detail, key);
      if (!keyed) {
        err.message = `الحد المجاني للصورة هو طلب واحد كل 45 ثانية تقريباً. حاول بعد ${wait} ثانية.`;
      }
      err.retryAfter = wait;
      throw err;
    }
    throw providerError(res.status === 200 ? 502 : res.status, detail, key);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (looksLikeJson(buffer)) {
    throw providerError(502, buffer.toString("utf8").slice(0, 300), key);
  }
  if (!ctype.startsWith("image/") || buffer.length < 32) {
    const err = new Error("المزود لم يُرجع صورة. قد يكون الطلب مرفوضاً من فلتر السلامة.");
    err.code = "provider_rejected";
    throw err;
  }
  const mimeType = ctype.split(";")[0].trim() || "image/jpeg";
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  return { buffer, mimeType, ext };
}

export const pollinationsProvider = {
  id: "pollinations",
  supportsVideo: false,
  get maxCount() {
    return pollinationsApiKey() ? 10 : 1;
  },
  async generateImage({ prompt, aspectRatio, n, enhance }) {
    const count = Math.max(1, Number(n) || 1);
    const key = pollinationsApiKey();
    if (!key && count > 1) {
      const err = new Error("المزود المجاني ينشئ صورة واحدة في كل طلب، وبفاصل حوالي 45 ثانية.");
      err.code = "limit";
      throw err;
    }
    if (count > 10) {
      const err = new Error("الحد الأقصى لكل طلب صورة هو 10.");
      err.code = "limit";
      throw err;
    }
    const images = [];
    for (let i = 0; i < count; i += 1) {
      images.push(await requestImage({ prompt, aspectRatio, key, enhance: Boolean(enhance) }));
    }
    return { images };
  },
  async generateVideo() {
    const err = new Error("الفيديو غير متاح على مزود Pollinations. قريباً، أو فعّل مزوداً يدعم الفيديو مثل xAI.");
    err.code = "disabled";
    throw err;
  },
};
