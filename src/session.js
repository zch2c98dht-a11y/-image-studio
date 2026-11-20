import crypto from "node:crypto";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const revokedAdminCookies = new Set();

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

function secureFlag() {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

function cookieFlags() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secureFlag()}`;
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("hex");
}

export function adminCookieValid(value) {
  if (!value || revokedAdminCookies.has(value)) return false;
  const parts = String(value).split(".");
  if (parts.length !== 3) return false;
  const [expRaw, token, sig] = parts;
  if (!/^\d+$/.test(expRaw) || !/^[0-9a-f]{64}$/i.test(token) || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  if (Number(expRaw) <= Date.now()) return false;
  const expected = sign(`${expRaw}.${token}`);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function attachSession(req, res, next) {
  const cookies = parseCookies(req);
  let sid = cookies.sid;
  if (!sid || !UUID_RE.test(sid)) {
    sid = crypto.randomUUID();
    res.append("Set-Cookie", `sid=${sid}; ${cookieFlags()}`);
  }
  req.sessionId = sid;
  req.isAdmin = adminCookieValid(cookies.admin);
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(401).json({ ok: false, error: "يلزم تسجيل دخول المدير." });
  }
  next();
}

export function createAdminSession(res) {
  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const token = crypto.randomBytes(32).toString("hex");
  const payload = `${exp}.${token}`;
  const value = `${payload}.${sign(payload)}`;
  res.append("Set-Cookie", `admin=${value}; ${cookieFlags()}`);
}

export function clearAdminSession(req, res) {
  const cookies = parseCookies(req);
  if (cookies.admin) revokedAdminCookies.add(cookies.admin);
  res.append("Set-Cookie", `admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`);
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

setInterval(() => {
  const now = Date.now();
  for (const value of revokedAdminCookies) {
    const exp = Number(String(value).split(".")[0]);
    if (!Number.isFinite(exp) || exp <= now) revokedAdminCookies.delete(value);
  }
}, 60 * 60 * 1000).unref();
