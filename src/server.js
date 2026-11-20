import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { moderatePrompt, moderationPolicyNote } from "./moderation.js";
import { finalizePrompt } from "./prompt-prep.js";
import { getProvider, providerName } from "./providers/index.js";
import {
  attachSession,
  checkAdminPassword,
  clearAdminSession,
  createAdminSession,
  requireAdmin,
} from "./session.js";
import {
  addGalleryItems,
  assertCanGenerate,
  getSettings,
  initStore,
  galleryItemForFile,
  listGallery,
  logUsage,
  mediaPath,
  MEDIA_DIR,
  PRIVATE_MODE_MESSAGE,
  publicConfig,
  updateSettings,
  getUsage,
  getQuota,
} from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

initStore();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(attachSession);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

function redactSecrets(text) {
  let out = String(text || "");
  for (const name of ["POLLINATIONS_API_KEY", "XAI_API_KEY", "ADMIN_PASSWORD", "SESSION_SECRET"]) {
    const secret = String(process.env[name] || "").trim();
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function validateOptions(body, settings) {
  const type = body.type === "video" ? "video" : "image";
  const style = String(body.style || settings.defaultStyle || "").trim();
  const aspectRatio = String(body.aspectRatio || settings.defaultAspectRatio || "1:1").trim();
  const resolution = String(body.resolution || settings.defaultResolution || "1k").trim();
  const duration = Number(body.duration || settings.defaultDuration || 8);
  const count = Math.max(1, Number(body.count) || 1);

  if (style && settings.allowedStyles.length && !settings.allowedStyles.includes(style)) {
    throw Object.assign(new Error("هذا الأسلوب غير مسموح."), { code: "invalid" });
  }
  if (!settings.allowedAspectRatios.includes(aspectRatio)) {
    throw Object.assign(new Error("نسبة الأبعاد غير مسموحة."), { code: "invalid" });
  }
  if (!settings.allowedResolutions.includes(resolution)) {
    throw Object.assign(new Error("الحجم أو الدقة غير مسموحين."), { code: "invalid" });
  }
  if (type === "video" && !settings.allowedDurations.includes(duration)) {
    throw Object.assign(new Error("مدة الفيديو غير مسموحة."), { code: "invalid" });
  }
  return { type, style, aspectRatio, resolution, duration, count };
}

function writeMedia(buffer, ext) {
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  fs.writeFileSync(mediaPath(filename), buffer);
  return { id, filename, url: `/media/${filename}` };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: providerName() });
});

app.get("/api/config", (req, res) => {
  res.json({ ok: true, ...publicConfig(req.sessionId, req.isAdmin) });
});

app.get("/api/gallery", (req, res) => {
  const items = listGallery(req.sessionId).map(({ sessionId, ...rest }) => rest);
  res.json({ ok: true, items });
});

app.post("/api/generate", async (req, res) => {
  if (getSettings().privateMode && !req.isAdmin) {
    const prompt = String(req.body?.prompt || "").trim();
    logUsage({
      id: crypto.randomUUID(),
      sessionId: req.sessionId,
      isAdmin: false,
      type: req.body?.type === "video" ? "video" : "image",
      prompt,
      status: "blocked",
      reason: "private",
      message: PRIVATE_MODE_MESSAGE,
    });
    return res.status(403).json({
      ok: false,
      error: PRIVATE_MODE_MESSAGE,
      reason: "private",
    });
  }

  const prompt = String(req.body?.prompt || "").trim();
  const settings = getSettings();
  let options;
  try {
    options = validateOptions(req.body || {}, settings);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  const moderation = moderatePrompt(prompt);
  if (!moderation.allowed) {
    logUsage({
      id: crypto.randomUUID(),
      sessionId: req.sessionId,
      isAdmin: req.isAdmin,
      type: options.type,
      prompt,
      style: options.style,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      count: options.count,
      duration: options.type === "video" ? options.duration : null,
      status: "blocked",
      reason: moderation.reason,
      message: moderation.message,
    });
    return res.status(400).json({
      ok: false,
      error: moderation.message,
      reason: moderation.reason,
      policy: moderationPolicyNote(),
    });
  }

  try {
    assertCanGenerate({
      sessionId: req.sessionId,
      isAdmin: req.isAdmin,
      type: options.type,
      count: options.type === "video" ? 1 : options.count,
    });
  } catch (err) {
    return res.status(403).json({ ok: false, error: err.message, reason: err.code });
  }

  const prepared = await finalizePrompt({
    prompt,
    style: options.style,
    enhance: settings.enhancePrompts !== false,
  });
  if (!prepared.ok) {
    logUsage({
      id: crypto.randomUUID(),
      sessionId: req.sessionId,
      isAdmin: req.isAdmin,
      type: options.type,
      prompt,
      style: options.style,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      count: options.count,
      duration: options.type === "video" ? options.duration : null,
      status: "blocked",
      reason: prepared.moderation.reason,
      message: prepared.moderation.message,
    });
    return res.status(400).json({
      ok: false,
      error: prepared.moderation.message,
      reason: prepared.moderation.reason,
      policy: moderationPolicyNote(),
    });
  }

  const fullPrompt = prepared.providerPrompt;
  const promptEn = prepared.promptEn && prepared.promptEn !== prompt ? prepared.promptEn : null;
  const started = Date.now();

  try {
    const provider = getProvider();
    const items = [];
    if (options.type === "image") {
      const result = await provider.generateImage({
        prompt: fullPrompt,
        style: options.style,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        n: options.count,
        enhance: settings.enhancePrompts !== false,
      });
      for (const image of result.images) {
        const file = writeMedia(image.buffer, image.ext || "jpg");
        items.push({
          id: file.id,
          type: "image",
          url: file.url,
          mimeType: image.mimeType,
          prompt,
          promptEn,
          style: options.style,
          aspectRatio: options.aspectRatio,
          resolution: options.resolution,
          createdAt: new Date().toISOString(),
          sessionId: req.sessionId,
        });
      }
    } else {
      const result = await provider.generateVideo({
        prompt: fullPrompt,
        enhance: settings.enhancePrompts !== false,
        style: options.style,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        duration: options.duration,
      });
      const file = writeMedia(result.video.buffer, result.video.ext || "mp4");
      items.push({
        id: file.id,
        type: "video",
        url: file.url,
        mimeType: result.video.mimeType,
        prompt,
        promptEn,
        style: options.style,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        duration: result.video.duration || options.duration,
        createdAt: new Date().toISOString(),
        sessionId: req.sessionId,
      });
    }

    addGalleryItems(items);
    logUsage({
      id: crypto.randomUUID(),
      sessionId: req.sessionId,
      isAdmin: req.isAdmin,
      type: options.type,
      prompt,
      style: options.style,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      count: items.length,
      duration: options.type === "video" ? options.duration : null,
      status: "ok",
      message: `provider=${providerName()}; ms=${Date.now() - started}`,
    });

    res.json({
      ok: true,
      items: items.map(({ sessionId, ...rest }) => rest),
      quota: getQuota(req.sessionId, req.isAdmin),
    });
  } catch (err) {
    logUsage({
      id: crypto.randomUUID(),
      sessionId: req.sessionId,
      isAdmin: req.isAdmin,
      type: options.type,
      prompt,
      style: options.style,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      count: options.count,
      duration: options.type === "video" ? options.duration : null,
      status: "error",
      reason: err.code || "provider",
      message: redactSecrets(err.message),
    });
    const status = err.code === "not_configured" || err.code === "not_implemented" ? 501 : 502;
    res.status(status).json({
      ok: false,
      error: redactSecrets(err.message || "تعذر الإنشاء حالياً."),
      reason: err.code || "provider",
    });
  }
});

app.get("/media/:file", (req, res) => {
  const filename = path.basename(req.params.file);
  const filePath = path.join(MEDIA_DIR, filename);
  if (!filename || filename !== req.params.file || !fs.existsSync(filePath)) {
    return res.status(404).send("غير موجود");
  }
  const item = galleryItemForFile(filename);
  const ownsFile = item && (req.isAdmin || item.sessionId === req.sessionId);
  if (!ownsFile) {
    return res.status(403).type("text/plain; charset=utf-8").send("غير مسموح");
  }
  if (req.query.download) {
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  } else {
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  }
  res.sendFile(filePath);
});

app.post("/api/admin/login", (req, res) => {
  try {
    const ok = checkAdminPassword(req.body?.password);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "كلمة السر غير صحيحة." });
    }
    createAdminSession(res);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/logout", (req, res) => {
  clearAdminSession(req, res);
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ ok: false, authenticated: false });
  res.json({ ok: true, authenticated: true, policy: moderationPolicyNote() });
});

app.get("/api/admin/settings", requireAdmin, (_req, res) => {
  res.json({ ok: true, settings: getSettings() });
});

app.put("/api/admin/settings", requireAdmin, (req, res) => {
  try {
    const allowed = [
      "privateMode",
      "enhancePrompts",
      "imageEnabled",
      "videoEnabled",
      "dailyImageLimit",
      "dailyVideoLimit",
      "maxCount",
      "allowedStyles",
      "allowedAspectRatios",
      "allowedResolutions",
      "allowedDurations",
      "defaultStyle",
      "defaultAspectRatio",
      "defaultResolution",
      "defaultDuration",
    ];
    const patch = {};
    for (const key of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
        patch[key] = req.body[key];
      }
    }
    const settings = updateSettings(patch);
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/logs", requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const logs = getUsage().slice(-limit).reverse();
  res.json({ ok: true, logs });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.use(express.static(publicDir, { extensions: ["html"] }));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: "المسار غير موجود." });
  }
  res.status(404).sendFile(path.join(publicDir, "index.html"));
});

const port = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV !== "test") {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Image Video Studio listening on http://localhost:${port}`);
  });
}

export { app };
