const els = {
  prompt: document.getElementById("prompt"),
  style: document.getElementById("style"),
  aspectRatio: document.getElementById("aspectRatio"),
  resolution: document.getElementById("resolution"),
  count: document.getElementById("count"),
  duration: document.getElementById("duration"),
  countField: document.getElementById("countField"),
  durationField: document.getElementById("durationField"),
  generateBtn: document.getElementById("generateBtn"),
  status: document.getElementById("status"),
  gallery: document.getElementById("gallery"),
  emptyGallery: document.getElementById("emptyGallery"),
  galleryCount: document.getElementById("galleryCount"),
  quotaBadge: document.getElementById("quotaBadge"),
  videoModeBtn: document.getElementById("videoModeBtn"),
  videoLockTag: document.getElementById("videoLockTag"),
  composerHint: document.getElementById("composerHint"),
};

let config = null;
let mode = "image";

function setStatus(text, kind = "") {
  els.status.hidden = !text;
  els.status.textContent = text || "";
  els.status.className = `status ${kind}`.trim();
}

function fillSelect(select, values, selected, labelFn = (v) => v) {
  select.innerHTML = "";
  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = labelFn(value);
    if (String(value) === String(selected)) opt.selected = true;
    select.appendChild(opt);
  }
}

function applyPrivateLock() {
  const locked = !!config?.privateLocked;
  const notice = document.getElementById("privateNotice");
  const composer = document.querySelector(".composer");
  if (notice) notice.hidden = !locked;
  if (composer) composer.classList.toggle("is-private", locked);
  for (const el of [els.prompt, els.style, els.aspectRatio, els.resolution, els.count, els.duration, els.generateBtn]) {
    if (el) el.disabled = locked;
  }
  document.querySelectorAll(".mode").forEach((btn) => {
    btn.disabled = locked;
  });
}

function updateQuota(quota) {
  if (!quota) return;
  if (config?.privateLocked) {
    els.quotaBadge.textContent = "وضع خاص";
    return;
  }
  if (quota.unlimited || quota.isAdmin) {
    els.quotaBadge.textContent = quota.isAdmin ? "مدير · بلا حد يومي" : "بلا حد يومي";
    return;
  }
  const imgLeft =
    quota.imageLimit === 0 ? "∞" : Math.max(0, quota.imageLimit - quota.imageUsed);
  if (!config || config.videoLocked) {
    els.quotaBadge.textContent = `المتبقي اليوم: ${imgLeft} صورة`;
    return;
  }
  const vidLeft =
    quota.videoLimit === 0 ? "∞" : Math.max(0, quota.videoLimit - quota.videoUsed);
  els.quotaBadge.textContent = `المتبقي اليوم: ${imgLeft} صورة · ${vidLeft} فيديو`;
}

function applyVideoLock() {
  const locked = !config || config.videoLocked !== false;
  const btn = els.videoModeBtn;
  if (!btn) return;
  btn.classList.toggle("locked", locked);
  btn.setAttribute("aria-disabled", String(locked));
  if (els.videoLockTag) {
    els.videoLockTag.hidden = !locked;
    els.videoLockTag.textContent = config?.videoLockLabel || "مقفل";
  }
  if (locked && mode === "video") {
    mode = "image";
  }
  if (els.composerHint && config) {
    const parts = [
      "النتائج تُحفظ في معرضك على هذا الجهاز. سياسة المحتوى تنطبق على الجميع.",
    ];
    if (config.videoLocked) parts.push(config.videoLockHint || "الفيديو مقفل / قريباً.");
    if (config.provider === "pollinations") {
      parts.push("المزود المجاني: صورة واحدة كل 45 ثانية تقريباً، وأكبر حجم 768 بكسل.");
    }
    els.composerHint.textContent = parts.join(" ");
  }
}

function applyMode() {
  const isVideo = mode === "video" && config && !config.videoLocked;
  mode = isVideo ? "video" : "image";
  els.durationField.classList.toggle("hidden", !isVideo);
  els.countField.classList.toggle("hidden", isVideo);
  document.querySelectorAll(".mode").forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
}

function renderGallery(items) {
  els.gallery.innerHTML = "";
  els.emptyGallery.hidden = items.length > 0;
  els.galleryCount.textContent = items.length ? `${items.length} عمل` : "";
  for (const item of items) {
    const tile = document.createElement("article");
    tile.className = "tile";
    const media =
      item.type === "video"
        ? `<video src="${item.url}" controls playsinline></video>`
        : `<img src="${item.url}" alt="${escapeHtml(item.prompt || "")}">`;
    tile.innerHTML = `
      ${media}
      <div class="tile-body">
        <p>${escapeHtml(item.prompt || "")}</p>
        <a href="${item.url}?download=1" download>تنزيل</a>
      </div>
    `;
    els.gallery.appendChild(tile);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "حصل خطأ غير متوقع.");
  }
  return data;
}

async function load() {
  config = await api("/api/config");
  fillSelect(els.style, config.allowedStyles, config.defaultStyle);
  fillSelect(els.aspectRatio, config.allowedAspectRatios, config.defaultAspectRatio);
  fillSelect(els.resolution, config.allowedResolutions, config.defaultResolution, (v) =>
    v === "2k" ? "2K" : v === "1k" ? "1K" : v,
  );
  fillSelect(
    els.duration,
    config.allowedDurations,
    config.defaultDuration,
    (v) => `${v} ثوانٍ`,
  );
  const counts = [];
  for (let i = 1; i <= (config.maxCount || 1); i += 1) counts.push(i);
  fillSelect(els.count, counts, 1);
  applyVideoLock();
  applyPrivateLock();
  updateQuota(config.quota);
  applyMode();
  const gallery = await api("/api/gallery");
  renderGallery(gallery.items || []);
}

document.querySelectorAll(".mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.mode === "video" && config?.videoLocked) {
      setStatus(config.videoLockHint || "الفيديو مقفل / قريباً.", "error");
      return;
    }
    mode = btn.dataset.mode;
    applyMode();
  });
});

els.generateBtn.addEventListener("click", async () => {
  if (config?.privateLocked) {
    setStatus(config.privateNotice || "التطبيق خاص حالياً، صنع الصور للمدير فقط", "error");
    return;
  }
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    setStatus("اكتب وصفاً أولاً.", "error");
    return;
  }
  els.generateBtn.disabled = true;
  setStatus(mode === "video" ? "جارٍ إنشاء الفيديو… قد يأخذ وقتاً." : "جارٍ الإنشاء…");
  try {
    const data = await api("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        type: mode,
        prompt,
        style: els.style.value,
        aspectRatio: els.aspectRatio.value,
        resolution: els.resolution.value,
        count: Number(els.count.value) || 1,
        duration: Number(els.duration.value) || undefined,
      }),
    });
    updateQuota(data.quota);
    const gallery = await api("/api/gallery");
    renderGallery(gallery.items || []);
    setStatus("تم الإنشاء.", "ok");
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    els.generateBtn.disabled = !!config?.privateLocked;
  }
});

load().catch((err) => setStatus(err.message, "error"));
