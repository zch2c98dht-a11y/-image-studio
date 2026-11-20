/**
 * مزود xAI الرسمي.
 * الصور: POST https://api.x.ai/v1/images/generations  (النموذج الافتراضي grok-imagine-image-2.0)
 * الفيديو: POST https://api.x.ai/v1/videos/generations ثم استطلاع GET https://api.x.ai/v1/videos/{request_id}
 *   (النموذج الافتراضي grok-imagine-video-1.5)
 * المصادر:
 *   https://docs.x.ai/developers/rest-api-reference/inference/images
 *   https://docs.x.ai/developers/rest-api-reference/inference/videos
 *   https://docs.x.ai/developers/model-capabilities/imagine
 *   https://docs.x.ai/developers/model-capabilities/video/generation
 */

const API_BASE = "https://api.x.ai/v1";

function apiKey() {
  const key = process.env.XAI_API_KEY || "";
  if (!key) {
    const err = new Error("مفتاح XAI_API_KEY غير موجود. ضعه في متغيرات البيئة على الخادم.");
    err.code = "not_configured";
    throw err;
  }
  return key;
}

async function xaiFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      data?.error ||
      `رفض مزود xAI الطلب (رمز ${res.status}).`;
    const err = new Error(typeof msg === "string" ? msg : "رفض مزود xAI الطلب.");
    err.code = res.status === 400 || res.status === 422 ? "provider_rejected" : "provider";
    err.status = res.status;
    throw err;
  }
  return data;
}

function extFromMime(mime, fallback) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "video/mp4") return "mp4";
  return fallback;
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("تعذر تنزيل الملف الناتج من المزود.");
  }
  const mimeType = res.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType };
}

export const xaiProvider = {
  id: "xai",
  supportsVideo: true,
  async generateImage({ prompt, aspectRatio, resolution, n, quality }) {
    const model = process.env.XAI_IMAGE_MODEL || "grok-imagine-image-2.0";
    const data = await xaiFetch("/images/generations", {
      method: "POST",
      body: {
        model,
        prompt,
        aspect_ratio: aspectRatio,
        resolution: resolution || "1k",
        n: Math.max(1, n || 1),
        quality: quality || "medium",
        response_format: "b64_json",
      },
    });
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (!rows.length) {
      throw new Error("المزود لم يُرجع أي صورة.");
    }
    const images = [];
    for (const row of rows) {
      if (row.b64_json) {
        const mimeType = row.mime_type || "image/jpeg";
        images.push({
          buffer: Buffer.from(row.b64_json, "base64"),
          mimeType,
          ext: extFromMime(mimeType, "jpg"),
        });
      } else if (row.url) {
        const file = await downloadToBuffer(row.url);
        images.push({
          buffer: file.buffer,
          mimeType: row.mime_type || file.mimeType,
          ext: extFromMime(row.mime_type || file.mimeType, "jpg"),
        });
      }
    }
    if (!images.length) throw new Error("تعذر قراءة صور المزود.");
    return { images };
  },

  async generateVideo({ prompt, aspectRatio, resolution, duration }) {
    const model = process.env.XAI_VIDEO_MODEL || "grok-imagine-video-1.5";
    const started = await xaiFetch("/videos/generations", {
      method: "POST",
      body: {
        model,
        prompt,
        duration: Number(duration) || 8,
        aspect_ratio: aspectRatio || "16:9",
        resolution: resolution === "2k" ? "1080p" : resolution === "1k" ? "720p" : resolution || "720p",
      },
    });
    const requestId = started?.request_id;
    if (!requestId) throw new Error("المزود لم يُرجع معرف طلب الفيديو.");

    const interval = Number(process.env.XAI_VIDEO_POLL_MS) || 4000;
    const timeout = Number(process.env.XAI_VIDEO_TIMEOUT_MS) || 300000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const result = await xaiFetch(`/videos/${requestId}`);
      const status = result?.status;
      if (status === "done") {
        const video = result.video || {};
        if (video.respect_moderation === false || !video.url) {
          const err = new Error("المزود رفض النتيجة بسبب سياسة المحتوى.");
          err.code = "provider_rejected";
          throw err;
        }
        const file = await downloadToBuffer(video.url);
        return {
          video: {
            buffer: file.buffer,
            mimeType: file.mimeType.startsWith("video/") ? file.mimeType : "video/mp4",
            ext: "mp4",
            duration: video.duration || duration,
          },
        };
      }
      if (status === "failed" || status === "expired") {
        const err = new Error(result?.error || "فشل إنشاء الفيديو لدى المزود.");
        err.code = "provider";
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error("انتهت مهلة انتظار الفيديو. حاول مرة أخرى بعد قليل.");
  },
};
