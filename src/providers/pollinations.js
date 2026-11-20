/**
 * مزود Pollinations المجاني (بدون مفتاح).
 * المسار الكلاسيكي الذي لا يحتاج حساباً ولا مفتاحاً:
 *   GET https://image.pollinations.ai/prompt/{URL-encoded-prompt}?width=&height=&seed=&safe=
 * المصدر: https://github.com/pollinations/pollinations/blob/master/APIDOCS.md
 *         (Pollinations Classic API)
 *
 * حدود الخطة المجانية حسب الوثائق: صورة واحدة في كل مرة، وبفاصل 45 ثانية على الأقل لكل عنوان IP.
 * تجاوز الحد يعيد HTTP 402 مع رأس Retry-After.
 * الحد الأقصى للمساحة 768×768 مع الحفاظ على نسبة الأبعاد.
 *
 * ملاحظة: المسار الحديث https://gen.pollinations.ai/image/{prompt} يطلب مفتاحاً للطلبات الجديدة،
 * لذلك لا يُستخدم هنا كخيار مجاني.
 */

const BASE = "https://image.pollinations.ai/prompt";
const MAX_EDGE = 768;
const RATIOS = {
  "1:1": [1, 1],
  "16:9": [16, 9],
  "9:16": [9, 16],
  "3:2": [3, 2],
  "2:3": [2, 3],
  "4:3": [4, 3],
  "3:4": [3, 4],
};

export function pollinationsSize(aspectRatio) {
  const [rw, rh] = RATIOS[aspectRatio] || [1, 1];
  const scale = Math.min(MAX_EDGE / rw, MAX_EDGE / rh);
  return {
    width: Math.max(1, Math.round(rw * scale)),
    height: Math.max(1, Math.round(rh * scale)),
  };
}

function parseRetryAfter(res) {
  const raw = res.headers.get("retry-after") || res.headers.get("Retry-After");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 45;
}

async function readErrorMessage(res) {
  const ctype = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ctype.includes("application/json")) {
    try {
      const data = JSON.parse(text);
      return data.message || data.error || data.code || text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  }
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export const pollinationsProvider = {
  id: "pollinations",
  supportsVideo: false,
  maxCount: 1,
  async generateImage({ prompt, aspectRatio, n }) {
    if ((n || 1) > 1) {
      const err = new Error("المزود المجاني ينشئ صورة واحدة في كل طلب، وبفاصل حوالي 45 ثانية.");
      err.code = "limit";
      throw err;
    }
    const { width, height } = pollinationsSize(aspectRatio);
    const seed = Math.floor(Math.random() * 1_000_000_000);
    const url = new URL(`${BASE}/${encodeURIComponent(prompt)}`);
    url.searchParams.set("width", String(width));
    url.searchParams.set("height", String(height));
    url.searchParams.set("seed", String(seed));
    url.searchParams.set("safe", "true");

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "image/jpeg,image/png,image/webp,image/*,application/json",
        "User-Agent": "ImageVideoStudio/1.0 (self-hosted free client)",
      },
      signal: AbortSignal.timeout(120000),
    });

    if (res.status === 402 || res.status === 429) {
      const wait = parseRetryAfter(res);
      const err = new Error(
        `الحد المجاني للصورة هو طلب واحد كل 45 ثانية تقريباً. حاول بعد ${wait} ثانية.`,
      );
      err.code = "rate_limit";
      err.retryAfter = wait;
      throw err;
    }

    const ctype = res.headers.get("content-type") || "";
    if (!res.ok) {
      const detail = await readErrorMessage(res);
      const err = new Error(detail || `رفض المزود المجاني الطلب (رمز ${res.status}).`);
      err.code = res.status === 400 || res.status === 422 ? "provider_rejected" : "provider";
      err.status = res.status;
      throw err;
    }

    if (!ctype.startsWith("image/")) {
      const detail = await readErrorMessage(res);
      const err = new Error(detail || "المزود المجاني لم يُرجع صورة. قد يكون الطلب مرفوضاً من فلتر السلامة.");
      err.code = "provider_rejected";
      throw err;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 32) {
      throw new Error("الصورة المستلمة فارغة أو غير مكتملة.");
    }
    const mimeType = ctype.split(";")[0].trim() || "image/jpeg";
    const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
    return { images: [{ buffer, mimeType, ext }] };
  },
  async generateVideo() {
    const err = new Error("الفيديو غير متاح على المزود المجاني. قريباً، أو فعّل مزوداً مدفوعاً مثل xAI.");
    err.code = "disabled";
    throw err;
  },
};
