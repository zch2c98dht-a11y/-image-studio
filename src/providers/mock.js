import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sizeForRatio(aspectRatio, resolution) {
  const scale = resolution === "2k" ? 2 : 1;
  const map = {
    "1:1": [1024, 1024],
    "16:9": [1280, 720],
    "9:16": [720, 1280],
    "3:2": [1200, 800],
    "2:3": [800, 1200],
    "4:3": [1200, 900],
    "3:4": [900, 1200],
  };
  const [w, h] = map[aspectRatio] || [1024, 1024];
  return { width: w * scale, height: h * scale };
}

function wrapText(text, max = 42) {
  const words = String(text).trim().split(/\s+/).slice(0, 40);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 6);
}

function svgPlaceholder({ prompt, style, aspectRatio, resolution, index, total }) {
  const { width, height } = sizeForRatio(aspectRatio, resolution);
  const lines = wrapText(prompt || "بدون وصف");
  const text = lines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${height / 2 - ((lines.length - 1) * 28) / 2 + i * 36}" text-anchor="middle" fill="#f4efe4" font-size="28" font-family="Tahoma, Arial, sans-serif">${escapeXml(line)}</text>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1730"/>
      <stop offset="55%" stop-color="#12284d"/>
      <stop offset="100%" stop-color="#1a3a5c"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <circle cx="${width * 0.18}" cy="${height * 0.2}" r="3" fill="#f4efe4" opacity="0.7"/>
  <circle cx="${width * 0.72}" cy="${height * 0.16}" r="2" fill="#e8c872" opacity="0.9"/>
  <circle cx="${width * 0.84}" cy="${height * 0.32}" r="1.5" fill="#fff" opacity="0.6"/>
  <circle cx="${width * 0.3}" cy="${height * 0.78}" r="2" fill="#fff" opacity="0.45"/>
  <text x="${width / 2}" y="${Math.max(64, height * 0.12)}" text-anchor="middle" fill="#e8c872" font-size="22" font-family="Tahoma, Arial, sans-serif">وضع تجريبي · ${escapeXml(style || "بدون أسلوب")}</text>
  ${text}
  <text x="${width / 2}" y="${height - 48}" text-anchor="middle" fill="#9aa7bf" font-size="18" font-family="Tahoma, Arial, sans-serif">${escapeXml(aspectRatio)} · ${escapeXml(resolution)} · ${index + 1}/${total}</text>
</svg>`;
}

async function renderMockVideo({ prompt, aspectRatio, duration }) {
  const { width, height } = sizeForRatio(aspectRatio, "1k");
  const w = Math.max(320, Math.round(width / 2 / 2) * 2);
  const h = Math.max(320, Math.round(height / 2 / 2) * 2);
  const tmp = path.join(os.tmpdir(), `ivs-${crypto.randomUUID()}.mp4`);
  const label = String(prompt || "فيديو تجريبي").replace(/[:\\']/g, " ").slice(0, 80);
  const seconds = Math.min(15, Math.max(1, Number(duration) || 4));
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x0b1730:s=${w}x${h}:d=${seconds}:r=12`,
        "-vf",
        `drawtext=text='MOCK VIDEO':fontcolor=0xE8C872:fontsize=28:x=(w-text_w)/2:y=h*0.28,drawtext=text='${label}':fontcolor=white:fontsize=20:x=(w-text_w)/2:y=h*0.48`,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        tmp,
      ],
      { timeout: 20000 },
    );
    const buffer = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buffer;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    // فيديو بديل قصير جداً إذا تعذر ffmpeg مع النص
    const fallback = path.join(os.tmpdir(), `ivs-fb-${crypto.randomUUID()}.mp4`);
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x0b1730:s=640x360:d=${seconds}:r=12`,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        fallback,
      ],
      { timeout: 20000 },
    );
    const buffer = fs.readFileSync(fallback);
    fs.unlinkSync(fallback);
    return buffer;
  }
}

export const mockProvider = {
  id: "mock",
  supportsVideo: true,
  async generateImage({ prompt, style, aspectRatio, resolution, n }) {
    const total = Math.max(1, n || 1);
    const images = [];
    for (let i = 0; i < total; i += 1) {
      const svg = svgPlaceholder({ prompt, style, aspectRatio, resolution, index: i, total });
      images.push({
        buffer: Buffer.from(svg, "utf8"),
        mimeType: "image/svg+xml",
        ext: "svg",
      });
    }
    return { images };
  },
  async generateVideo({ prompt, aspectRatio, duration }) {
    const buffer = await renderMockVideo({ prompt, aspectRatio, duration });
    return {
      video: {
        buffer,
        mimeType: "video/mp4",
        ext: "mp4",
        duration: Number(duration) || 8,
      },
    };
  },
};
