import crypto from "node:crypto";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const adminTokens = new Map();

function secret() {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  }
  return process.env.SESSION_SECRET;
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = val;
  }
  return out;
}

function cookieFlags() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

export function attachSession(req, res, next) {
  const cookies = parseCookies(req);
  let sid = cookies.sid;
  if (!sid || !UUID_RE.test(sid)) {
    sid = crypto.randomUUID();
    res.append("Set-Cookie", `sid=${sid}; ${cookieFlags()}`);
  }
  req.sessionId = sid;
  req.isAdmin = Boolean(cookies.admin && adminTokens.get(cookies.admin));
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(401).json({ ok: false, error: "يلزم تسجيل دخول المدير." });
  }
  next();
}

export function createAdminSession(res) {
  const token = crypto.randomBytes(32).toString("hex");
  const sig = crypto.createHmac("sha256", secret()).update(token).digest("hex");
  const value = `${token}.${sig}`;
  adminTokens.set(value, Date.now());
  res.append("Set-Cookie", `admin=${value}; ${cookieFlags()}`);
}

export function clearAdminSession(req, res) {
  const cookies = parseCookies(req);
  if (cookies.admin) adminTokens.delete(cookies.admin);
  res.append("Set-Cookie", "admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

export function checkAdminPassword(input) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) {
    const err = new Error("كلمة سر الإدارة غير معيّنة. ضع ADMIN_PASSWORD في متغيرات البيئة.");
    err.code = "not_configured";
    throw err;
  }
  const a = Buffer.from(String(input ?? ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    const padded = Buffer.alloc(b.length);
    a.copy(padded);
    crypto.timingSafeEqual(padded, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// تنظيف الجلسات القديمة كل ساعة تقريباً
setInterval(() => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [token, at] of adminTokens) {
    if (at < cutoff) adminTokens.delete(token);
  }
}, 60 * 60 * 1000).unref();
