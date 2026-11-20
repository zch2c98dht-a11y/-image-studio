const loginCard = document.getElementById("loginCard");
const adminApp = document.getElementById("adminApp");
const logoutBtn = document.getElementById("logoutBtn");
const loginStatus = document.getElementById("loginStatus");
const saveStatus = document.getElementById("saveStatus");

function setStatus(el, text, kind = "") {
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `status ${kind}`.trim();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || "حصل خطأ غير متوقع.");
    err.status = res.status;
    throw err;
  }
  return data;
}

function csvFrom(arr) {
  return (arr || []).join(", ");
}
function listFrom(text) {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fillSettings(settings) {
  document.getElementById("imageEnabled").checked = !!settings.imageEnabled;
  document.getElementById("videoEnabled").checked = !!settings.videoEnabled;
  document.getElementById("dailyImageLimit").value = settings.dailyImageLimit;
  document.getElementById("dailyVideoLimit").value = settings.dailyVideoLimit;
  document.getElementById("maxCount").value = settings.maxCount;
  document.getElementById("allowedStyles").value = (settings.allowedStyles || []).join("\n");
  document.getElementById("allowedAspectRatios").value = csvFrom(settings.allowedAspectRatios);
  document.getElementById("allowedResolutions").value = csvFrom(settings.allowedResolutions);
  document.getElementById("allowedDurations").value = csvFrom(settings.allowedDurations);
}

function renderLogs(logs) {
  const box = document.getElementById("logs");
  box.innerHTML = "";
  if (!logs.length) {
    box.innerHTML = '<p class="empty">لا يوجد سجل بعد.</p>';
    return;
  }
  for (const log of logs) {
    const div = document.createElement("div");
    div.className = `log ${log.status}`;
    const when = log.at ? new Date(log.at).toLocaleString("ar-SA") : "";
    div.innerHTML = `
      <div><strong>${log.type === "video" ? "فيديو" : "صورة"}</strong> · ${statusLabel(log.status)}${log.isAdmin ? " · مدير" : ""}</div>
      <div>${escapeHtml(log.prompt || "")}</div>
      <div class="meta">${when} · جلسة ${escapeHtml(String(log.sessionId || "").slice(0, 8))} · العدد ${log.count || 1}${log.reason ? " · " + escapeHtml(log.reason) : ""}</div>
    `;
    box.appendChild(div);
  }
}

function statusLabel(status) {
  if (status === "ok") return "نجاح";
  if (status === "blocked") return "محظور";
  if (status === "error") return "خطأ";
  return status || "";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function showAdmin() {
  loginCard.classList.add("hidden");
  adminApp.classList.remove("hidden");
  logoutBtn.classList.remove("hidden");
  const me = await api("/api/admin/me");
  document.getElementById("policyBanner").textContent = me.policy || "";
  const settings = await api("/api/admin/settings");
  fillSettings(settings.settings);
  try {
    const cfg = await api("/api/config");
    const hint = document.getElementById("videoToggleHint");
    const box = document.getElementById("videoEnabled");
    if (!cfg.providerSupportsVideo) {
      box.disabled = true;
      box.checked = false;
      hint.textContent = "الفيديو مقفل / قريباً. المزود الحالي لا يدعم الفيديو. لفتحه ضع PROVIDER=xai مع XAI_API_KEY ثم فعّل الخيار هنا.";
    } else {
      box.disabled = false;
      hint.textContent = "المزود الحالي يدعم الفيديو. إذا فعّلته يظهر للمستخدمين. سياسة المحتوى تبقى سارية على المدير أيضاً.";
    }
  } catch {
    /* الإعدادات وحدها تكفي */
  }
  const logs = await api("/api/admin/logs");
  renderLogs(logs.logs || []);
}

async function boot() {
  try {
    await api("/api/admin/me");
    await showAdmin();
  } catch {
    loginCard.classList.remove("hidden");
    adminApp.classList.add("hidden");
    logoutBtn.classList.add("hidden");
  }
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  setStatus(loginStatus, "جارٍ التحقق…");
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: document.getElementById("password").value }),
    });
    document.getElementById("password").value = "";
    await showAdmin();
    setStatus(loginStatus, "");
  } catch (err) {
    setStatus(loginStatus, err.message, "error");
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST" });
  await boot();
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  setStatus(saveStatus, "جارٍ الحفظ…");
  try {
    await api("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        imageEnabled: document.getElementById("imageEnabled").checked,
        videoEnabled: document.getElementById("videoEnabled").checked,
        dailyImageLimit: Number(document.getElementById("dailyImageLimit").value),
        dailyVideoLimit: Number(document.getElementById("dailyVideoLimit").value),
        maxCount: Number(document.getElementById("maxCount").value),
        allowedStyles: listFrom(document.getElementById("allowedStyles").value),
        allowedAspectRatios: listFrom(document.getElementById("allowedAspectRatios").value),
        allowedResolutions: listFrom(document.getElementById("allowedResolutions").value),
        allowedDurations: listFrom(document.getElementById("allowedDurations").value).map(Number),
      }),
    });
    setStatus(saveStatus, "تم حفظ الإعدادات.", "ok");
  } catch (err) {
    setStatus(saveStatus, err.message, "error");
  }
});

document.getElementById("refreshLogs").addEventListener("click", async () => {
  const logs = await api("/api/admin/logs");
  renderLogs(logs.logs || []);
});

boot().catch((err) => setStatus(loginStatus, err.message, "error"));
