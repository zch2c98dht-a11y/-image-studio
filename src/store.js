import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, providerName } from "./providers/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.DATA_DIR || path.join(root, "data");
export const MEDIA_DIR = path.join(DATA_DIR, "media");

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const GALLERY_FILE = path.join(DATA_DIR, "gallery.json");

export const DEFAULT_SETTINGS = {
  imageEnabled: true,
  videoEnabled: false,
  dailyImageLimit: 10,
  dailyVideoLimit: 3,
  maxCount: 1,
  allowedStyles: [
    "واقعي",
    "سينمائي",
    "فن رقمي",
    "خيالي",
    "ألوان مائية",
    "ثلاثي الأبعاد",
    "بسيط",
    "كرتوني",
  ],
  allowedAspectRatios: ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4"],
  allowedResolutions: ["1k", "2k"],
  allowedDurations: [4, 6, 8, 10, 12, 15],
  defaultStyle: "سينمائي",
  defaultAspectRatio: "1:1",
  defaultResolution: "1k",
  defaultDuration: 8,
};

function ensureDirs() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function initStore() {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, DEFAULT_SETTINGS);
  if (!fs.existsSync(USAGE_FILE)) writeJson(USAGE_FILE, []);
  if (!fs.existsSync(GALLERY_FILE)) writeJson(GALLERY_FILE, []);
}

export function getSettings() {
  const saved = readJson(SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function updateSettings(patch) {
  const next = { ...getSettings(), ...patch };
  if (typeof next.imageEnabled !== "boolean") next.imageEnabled = !!next.imageEnabled;
  if (typeof next.videoEnabled !== "boolean") next.videoEnabled = !!next.videoEnabled;
  for (const key of ["dailyImageLimit", "dailyVideoLimit", "maxCount", "defaultDuration"]) {
    if (next[key] !== null && next[key] !== undefined && next[key] !== "") {
      const n = Number(next[key]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`قيمة غير صالحة: ${key}`);
      next[key] = n;
    }
  }
  if (next.maxCount > 10) next.maxCount = 10;
  for (const key of ["allowedStyles", "allowedAspectRatios", "allowedResolutions", "allowedDurations"]) {
    if (Array.isArray(next[key])) {
      next[key] = next[key]
        .map((v) => (typeof v === "string" ? v.trim() : v))
        .filter((v) => v !== "" && v !== null && v !== undefined);
    }
  }
  next.allowedDurations = (next.allowedDurations || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 15);
  writeJson(SETTINGS_FILE, next);
  return next;
}

export function getUsage() {
  return readJson(USAGE_FILE, []);
}

export function logUsage(entry) {
  const logs = getUsage();
  logs.push({
    id: entry.id,
    at: entry.at || new Date().toISOString(),
    sessionId: entry.sessionId,
    isAdmin: !!entry.isAdmin,
    type: entry.type,
    prompt: String(entry.prompt || "").slice(0, 400),
    style: entry.style || null,
    aspectRatio: entry.aspectRatio || null,
    resolution: entry.resolution || null,
    count: entry.count || 1,
    duration: entry.duration || null,
    status: entry.status,
    reason: entry.reason || null,
    message: entry.message || null,
  });
  // احتفظ بآخر 2000 سجل فقط
  writeJson(USAGE_FILE, logs.slice(-2000));
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function countToday(sessionId, type) {
  const today = dayKey();
  return getUsage().filter(
    (e) =>
      e.sessionId === sessionId &&
      e.type === type &&
      e.status === "ok" &&
      String(e.at || "").slice(0, 10) === today,
  ).reduce((sum, e) => sum + (Number(e.count) || 1), 0);
}

export function getQuota(sessionId, isAdmin) {
  const settings = getSettings();
  if (isAdmin) {
    return {
      isAdmin: true,
      imageUsed: countToday(sessionId, "image"),
      videoUsed: countToday(sessionId, "video"),
      imageLimit: null,
      videoLimit: null,
      maxCount: 10,
      unlimited: true,
    };
  }
  return {
    isAdmin: false,
    imageUsed: countToday(sessionId, "image"),
    videoUsed: countToday(sessionId, "video"),
    imageLimit: settings.dailyImageLimit,
    videoLimit: settings.dailyVideoLimit,
    maxCount: settings.maxCount,
    unlimited: settings.dailyImageLimit === 0 && settings.dailyVideoLimit === 0,
  };
}

export function assertCanGenerate({ sessionId, isAdmin, type, count }) {
  const settings = getSettings();
  if (type === "image" && !settings.imageEnabled) {
    const err = new Error("إنشاء الصور موقوف حالياً من لوحة الإدارة.");
    err.code = "disabled";
    throw err;
  }
  if (type === "video") {
    const provider = getProvider();
    if (!provider.supportsVideo) {
      const err = new Error("الفيديو مقفل في الإعداد المجاني. قريباً، أو فعّل مزوداً مدفوعاً يدعم الفيديو مثل xAI.");
      err.code = "disabled";
      throw err;
    }
    if (!settings.videoEnabled) {
      const err = new Error("إنشاء الفيديو موقوف حالياً من لوحة الإدارة.");
      err.code = "disabled";
      throw err;
    }
  }

  const n = Math.max(1, Number(count) || 1);
  const provider = getProvider();
  if (provider.maxCount && n > provider.maxCount) {
    const err = new Error(
      provider.id === "pollinations"
        ? "المزود المجاني ينشئ صورة واحدة في كل طلب، وبفاصل حوالي 45 ثانية."
        : `الحد الأقصى لهذا المزود في الطلب الواحد هو ${provider.maxCount}.`,
    );
    err.code = "limit";
    throw err;
  }
  if (isAdmin) {
    if (type === "image" && n > 10) {
      const err = new Error("الحد الأقصى لكل طلب صورة هو 10 (حد واجهة المزود).");
      err.code = "limit";
      throw err;
    }
    if (type === "video" && n > 1) {
      const err = new Error("يُنشأ فيديو واحد في كل طلب.");
      err.code = "limit";
      throw err;
    }
    return;
  }

  const maxCount = type === "video" ? 1 : Math.max(1, settings.maxCount);
  if (n > maxCount) {
    const err = new Error(`الحد الأقصى للعدد في الطلب الواحد هو ${maxCount}.`);
    err.code = "limit";
    throw err;
  }

  const quota = getQuota(sessionId, false);
  if (type === "image" && settings.dailyImageLimit > 0) {
    const left = settings.dailyImageLimit - quota.imageUsed;
    if (left <= 0 || n > left) {
      const err = new Error(
        left <= 0
          ? "وصلت للحد اليومي للصور. جرّب غداً أو اطلب من المدير رفع الحد."
          : `تبقى لك اليوم ${left} صورة فقط.`,
      );
      err.code = "limit";
      throw err;
    }
  }
  if (type === "video" && settings.dailyVideoLimit > 0) {
    const left = settings.dailyVideoLimit - quota.videoUsed;
    if (left <= 0) {
      const err = new Error("وصلت للحد اليومي للفيديو. جرّب غداً أو اطلب من المدير رفع الحد.");
      err.code = "limit";
      throw err;
    }
  }
}

export function listGallery(sessionId, { all = false, limit = 60 } = {}) {
  const items = readJson(GALLERY_FILE, []);
  const filtered = all ? items : items.filter((item) => item.sessionId === sessionId);
  return filtered.slice(-limit).reverse();
}

export function addGalleryItems(items) {
  const gallery = readJson(GALLERY_FILE, []);
  gallery.push(...items);
  writeJson(GALLERY_FILE, gallery.slice(-500));
}

export function mediaPath(filename) {
  const safe = path.basename(filename);
  return path.join(MEDIA_DIR, safe);
}

export function publicConfig(sessionId, isAdmin) {
  const settings = getSettings();
  const quota = getQuota(sessionId, isAdmin);
  const provider = getProvider();
  const videoAvailable = !!settings.videoEnabled && !!provider.supportsVideo;
  const maxCount = provider.maxCount ? Math.min(quota.maxCount, provider.maxCount) : quota.maxCount;
  return {
    imageEnabled: settings.imageEnabled,
    videoEnabled: settings.videoEnabled,
    videoAvailable,
    videoLocked: !videoAvailable,
    videoLockLabel: "مقفل",
    videoLockHint: provider.supportsVideo
      ? "الفيديو موقف من لوحة الإدارة."
      : "الفيديو قريباً. الإعداد المجاني للصور فقط، ويلزم مزود مدفوع مثل xAI لفتح الفيديو.",
    providerSupportsVideo: !!provider.supportsVideo,
    allowedStyles: settings.allowedStyles,
    allowedAspectRatios: settings.allowedAspectRatios,
    allowedResolutions: settings.allowedResolutions,
    allowedDurations: settings.allowedDurations,
    defaultStyle: settings.defaultStyle,
    defaultAspectRatio: settings.defaultAspectRatio,
    defaultResolution: settings.defaultResolution,
    defaultDuration: settings.defaultDuration,
    maxCount,
    quota: { ...quota, maxCount },
    provider: providerName(),
    policy:
      "سياسة المحتوى تُطبَّق على الجميع. وضع المدير يرفع حدود الاستخدام فقط ولا يتجاوز قواعد المحتوى أو مزود الذكاء الاصطناعي.",
  };
}
