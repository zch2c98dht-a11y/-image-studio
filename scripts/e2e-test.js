import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ivs-test-"));
const port = await getFreePort();
const adminPassword = "test-admin-password-not-for-production";

const child = spawn(process.execPath, ["src/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    PROVIDER: "mock",
    ADMIN_PASSWORD: adminPassword,
    DATA_DIR: dataDir,
    NODE_ENV: "test-run",
    XAI_API_KEY: "should-never-leak-to-browser",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (d) => {
  output += d.toString();
});
child.stderr.on("data", (d) => {
  output += d.toString();
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

function cookieJar() {
  const jar = new Map();
  return {
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    store(res) {
      const raw = res.headers.getSetCookie?.() || [];
      for (const c of raw) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (c.toLowerCase().includes("max-age=0") || value === "") jar.delete(name);
        else jar.set(name, value);
      }
    },
  };
}

async function waitForServer() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not start.\n${output}`);
}

async function req(jar, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...options, headers });
  jar.store(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, error: err.message });
      console.error(`  FAIL ${name}: ${err.message}`);
    });
}

try {
  await waitForServer();
  console.log(`Server ready on ${port}`);

  const user = cookieJar();
  const admin = cookieJar();

  await check("default provider is pollinations when unset", async () => {
    const prev = process.env.PROVIDER;
    delete process.env.PROVIDER;
    const mod = await import("../src/providers/index.js");
    assert.equal(mod.DEFAULT_PROVIDER, "pollinations");
    assert.equal(mod.providerName(), "pollinations");
    assert.equal(mod.providers.pollinations.supportsVideo, false);
    if (prev !== undefined) process.env.PROVIDER = prev;
  });

  await check("health endpoint", async () => {
    const { res, json } = await req(user, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.provider, "mock");
  });

  await check("user page is Arabic RTL and video is locked", async () => {
    const { res, text } = await req(user, "/");
    assert.equal(res.status, 200);
    assert.match(text, /lang="ar"/);
    assert.match(text, /dir="rtl"/);
    assert.match(text, /الاستوديو/);
    assert.match(text, /مقفل/);
  });

  await check("config has options, locked video, and no secrets", async () => {
    const { json } = await req(user, "/api/config");
    assert.equal(json.ok, true);
    assert.ok(json.imageEnabled);
    assert.equal(json.videoEnabled, false);
    assert.equal(json.videoLocked, true);
    assert.equal(json.videoAvailable, false);
    assert.equal(json.videoLockLabel, "مقفل");
    assert.ok(json.allowedStyles.length);
    const blob = JSON.stringify(json);
    assert.equal(blob.includes("should-never-leak-to-browser"), false);
    assert.equal(blob.includes(adminPassword), false);
    assert.equal(blob.includes("XAI_API_KEY"), false);
    assert.equal(json.quota.unlimited, false);
  });

  await check("generate mock image", async () => {
    const { res, json } = await req(user, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        type: "image",
        prompt: "واحة نجدية تحت سماء مليئة بالنجوم",
        style: "سينمائي",
        aspectRatio: "1:1",
        resolution: "1k",
        count: 1,
      }),
    });
    assert.equal(res.status, 200, json?.error || "image generate failed");
    assert.equal(json.items.length, 1);
    assert.equal(json.items[0].type, "image");
    const media = await req(user, json.items[0].url);
    assert.equal(media.res.status, 200);
    assert.match(media.res.headers.get("content-type"), /svg|image/);
    assert.equal(json.quota.imageUsed, 1);
  });

  await check("video stays locked until admin enables it", async () => {
    const { res, json } = await req(user, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        type: "video",
        prompt: "نجوم تتحرك فوق صحراء هادئة",
        style: "خيالي",
        aspectRatio: "16:9",
        resolution: "1k",
        duration: 4,
      }),
    });
    assert.equal(res.status, 403);
    assert.equal(json.reason, "disabled");
  });

  await check("gallery lists user results", async () => {
    const { json } = await req(user, "/api/gallery");
    assert.ok(json.items.length >= 1);
    assert.equal(json.items[0].type, "image");
  });

  await check("blocks sexual content even before provider", async () => {
    const { res, json } = await req(user, "/api/generate", {
      method: "POST",
      body: JSON.stringify({ type: "image", prompt: "صورة إباحية عارية", aspectRatio: "1:1", resolution: "1k" }),
    });
    assert.equal(res.status, 400);
    assert.equal(json.reason, "sexual_content");
  });

  await check("blocks celebrity requests", async () => {
    const { res, json } = await req(user, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        type: "image",
        prompt: "صورة لكريستيانو رونالدو في الاستاد",
        aspectRatio: "1:1",
        resolution: "1k",
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(json.reason, "celebrity");
  });

  await check("admin page loads", async () => {
    const { res, text } = await req(admin, "/admin");
    assert.equal(res.status, 200);
    assert.match(text, /لوحة الإدارة/);
  });

  await check("admin login rejects wrong password", async () => {
    const { res, json } = await req(admin, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(res.status, 401);
    assert.equal(json.ok, false);
    const me = await req(admin, "/api/admin/me");
    assert.equal(me.res.status, 401);
  });

  await check("admin login succeeds with env password", async () => {
    const { res, json } = await req(admin, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: adminPassword }),
    });
    assert.equal(res.status, 200, json?.error);
    assert.equal(json.ok, true);
    const me = await req(admin, "/api/admin/me");
    assert.equal(me.json.authenticated, true);
  });

  await check("admin can enable video on a provider that supports it", async () => {
    const { res, json } = await req(admin, "/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        videoEnabled: true,
        imageEnabled: true,
      }),
    });
    assert.equal(res.status, 200, json?.error);
    assert.equal(json.settings.videoEnabled, true);
    const cfg = await req(admin, "/api/config");
    assert.equal(cfg.json.videoAvailable, true);
    assert.equal(cfg.json.videoLocked, false);
  });

  await check("generate mock video after admin unlock", async () => {
    const { res, json } = await req(user, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        type: "video",
        prompt: "نجوم تتحرك فوق صحراء هادئة",
        style: "خيالي",
        aspectRatio: "16:9",
        resolution: "1k",
        duration: 4,
      }),
    });
    assert.equal(res.status, 200, json?.error || "video generate failed");
    assert.equal(json.items.length, 1);
    assert.equal(json.items[0].type, "video");
    const media = await req(user, `${json.items[0].url}?download=1`);
    assert.equal(media.res.status, 200);
    assert.match(media.res.headers.get("content-type"), /video|octet/);
    assert.match(media.res.headers.get("content-disposition") || "", /attachment/);
  });

  await check("admin can tighten user limits", async () => {
    const { res, json } = await req(admin, "/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        dailyImageLimit: 1,
        dailyVideoLimit: 1,
        maxCount: 1,
        imageEnabled: true,
        videoEnabled: true,
      }),
    });
    assert.equal(res.status, 200, json?.error);
    assert.equal(json.settings.dailyImageLimit, 1);
    assert.equal(json.settings.maxCount, 1);
  });

  await check("user hits daily image limit", async () => {
    // المستخدم أنشأ صورة واحدة سابقاً، والحد صار 1
    const { res, json } = await req(user, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        type: "image",
        prompt: "جبل أخضر بعد المطر",
        style: "واقعي",
        aspectRatio: "1:1",
        resolution: "1k",
        count: 1,
      }),
    });
    assert.equal(res.status, 403);
    assert.equal(json.reason, "limit");
  });

  await check("user hits max count per request", async () => {
    const other = cookieJar();
    await req(other, "/api/config");
    const { res, json } = await req(other, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        type: "image",
        prompt: "سماء صافية فوق البحر",
        style: "بسيط",
        aspectRatio: "1:1",
        resolution: "1k",
        count: 2,
      }),
    });
    assert.equal(res.status, 403);
    assert.equal(json.reason, "limit");
  });

  await check("admin has no daily limit on generate", async () => {
    const { json: cfg } = await req(admin, "/api/config");
    assert.equal(cfg.quota.isAdmin, true);
    assert.equal(cfg.quota.unlimited, true);
    assert.equal(cfg.maxCount, 10);
    const { res, json } = await req(admin, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        type: "image",
        prompt: "مكتبة عربية قديمة تحت ضوء القمر",
        style: "سينمائي",
        aspectRatio: "1:1",
        resolution: "1k",
        count: 3,
      }),
    });
    assert.equal(res.status, 200, json?.error);
    assert.equal(json.items.length, 3);
  });

  await check("admin still cannot bypass content policy", async () => {
    const { res, json } = await req(admin, "/api/generate", {
      method: "POST",
      body: JSON.stringify({ type: "image", prompt: "nude erotic portrait", aspectRatio: "1:1", resolution: "1k" }),
    });
    assert.equal(res.status, 400);
    assert.equal(json.reason, "sexual_content");
  });

  await check("usage logs visible to admin", async () => {
    const { json } = await req(admin, "/api/admin/logs");
    assert.ok(json.logs.length >= 5);
    assert.ok(json.logs.some((l) => l.status === "blocked"));
    assert.ok(json.logs.some((l) => l.status === "ok"));
  });

  await check("unauthenticated settings update is rejected", async () => {
    const stranger = cookieJar();
    const { res } = await req(stranger, "/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ imageEnabled: false }),
    });
    assert.equal(res.status, 401);
  });
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  process.exitCode = 1;
}
