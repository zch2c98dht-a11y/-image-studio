import assert from "node:assert/strict";
import { pollinationsProvider, pollinationsSize } from "../src/providers/pollinations.js";

const secret = "sk_test_pollinations_should-never-leak";
const originalFetch = globalThis.fetch;
const originalKey = process.env.POLLINATIONS_API_KEY;
const originalModel = process.env.POLLINATIONS_MODEL;

const results = [];

function pngResponse() {
  const bytes = new Uint8Array(48);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function restoreEnv() {
  if (originalKey === undefined) delete process.env.POLLINATIONS_API_KEY;
  else process.env.POLLINATIONS_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.POLLINATIONS_MODEL;
  else process.env.POLLINATIONS_MODEL = originalModel;
  globalThis.fetch = originalFetch;
}

try {
  await check("keyless route stays on the classic endpoint", async () => {
    delete process.env.POLLINATIONS_API_KEY;
    delete process.env.POLLINATIONS_MODEL;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return pngResponse();
    };
    const result = await pollinationsProvider.generateImage({
      prompt: "واحة هادئة",
      aspectRatio: "1:1",
      n: 1,
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, "image/png");
    assert.equal(calls.length, 1);
    const parsed = new URL(calls[0].url);
    assert.equal(parsed.origin, "https://image.pollinations.ai");
    assert.equal(parsed.pathname.startsWith("/prompt/"), true);
    assert.equal(parsed.searchParams.get("width"), "1024");
    assert.equal(parsed.searchParams.get("height"), "1024");
    assert.equal(parsed.searchParams.get("enhance"), null);
    assert.equal(parsed.searchParams.get("safe"), "true");
    assert.equal(parsed.searchParams.get("model"), null);
    assert.equal(parsed.searchParams.has("key"), false);
    assert.equal(calls[0].options.headers.Authorization, undefined);
    assert.equal(calls[0].url.includes(secret), false);
    assert.equal(pollinationsProvider.maxCount, 1);
    assert.deepEqual(pollinationsSize("1:1"), { width: 1024, height: 1024 });
  });

  await check("classic route sends enhance=true at the free 1024 size", async () => {
    delete process.env.POLLINATIONS_API_KEY;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return pngResponse();
    };
    await pollinationsProvider.generateImage({
      prompt: "a lantern",
      aspectRatio: "1:1",
      n: 1,
      enhance: true,
    });
    const parsed = new URL(calls[0]);
    assert.equal(parsed.origin, "https://image.pollinations.ai");
    assert.equal(parsed.searchParams.get("enhance"), "true");
    assert.equal(parsed.searchParams.get("width"), "1024");
    assert.equal(parsed.searchParams.get("height"), "1024");
    assert.equal(calls[0].includes("sk_"), false);
  });

  await check("keyless provider rejects multiple images before any request", async () => {
    delete process.env.POLLINATIONS_API_KEY;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return pngResponse();
    };
    await assert.rejects(
      () => pollinationsProvider.generateImage({ prompt: "بحر", aspectRatio: "1:1", n: 2 }),
      (err) => err.code === "limit",
    );
    assert.equal(called, false);
  });

  await check("keyed route uses gen.pollinations.ai and a bearer header", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    delete process.env.POLLINATIONS_MODEL;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return pngResponse();
    };
    const result = await pollinationsProvider.generateImage({
      prompt: "منارة على البحر",
      aspectRatio: "16:9",
      n: 2,
    });
    assert.equal(result.images.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(pollinationsProvider.maxCount, 10);
    assert.deepEqual(pollinationsSize("1:1", { keyed: true }), { width: 1024, height: 1024 });
    const seeds = new Set();
    for (const call of calls) {
      const parsed = new URL(call.url);
      assert.equal(parsed.origin, "https://gen.pollinations.ai");
      assert.equal(parsed.pathname.startsWith("/image/"), true);
      assert.equal(parsed.searchParams.get("model"), "flux");
      assert.equal(parsed.searchParams.get("width"), "1024");
      assert.equal(parsed.searchParams.get("height"), "576");
      assert.equal(parsed.searchParams.get("safe"), "true");
      assert.equal(parsed.searchParams.has("key"), false);
      assert.equal(parsed.searchParams.has("token"), false);
      assert.equal(call.url.includes(secret), false);
      assert.equal(call.options.headers.Authorization, `Bearer ${secret}`);
      assert.equal(JSON.stringify(call.options.headers).includes("?key="), false);
      seeds.add(parsed.searchParams.get("seed"));
      const blob = JSON.stringify(result);
      assert.equal(blob.includes(secret), false);
    }
    assert.equal(seeds.size, 2);
    await pollinationsProvider.generateImage({
      prompt: "a lantern",
      aspectRatio: "1:1",
      n: 1,
      enhance: true,
    });
    const keyedEnhanced = new URL(calls.at(-1).url);
    assert.equal(keyedEnhanced.origin, "https://gen.pollinations.ai");
    assert.equal(keyedEnhanced.searchParams.get("enhance"), null);
    assert.equal(keyedEnhanced.searchParams.get("width"), "1024");
    assert.equal(calls.at(-1).url.includes(secret), false);
  });

  await check("explicit free model alias is sent and paid models are not called", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    process.env.POLLINATIONS_MODEL = "black-forest-labs/flux.1-schnell";
    let seen = "";
    globalThis.fetch = async (url) => {
      seen = String(url);
      return pngResponse();
    };
    await pollinationsProvider.generateImage({ prompt: "حديقة", aspectRatio: "1:1", n: 1 });
    assert.equal(new URL(seen).searchParams.get("model"), "black-forest-labs/flux.1-schnell");
    assert.equal(seen.includes(secret), false);

    process.env.POLLINATIONS_MODEL = "openai/gpt-image-1.5";
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return pngResponse();
    };
    await assert.rejects(
      () => pollinationsProvider.generateImage({ prompt: "حديقة", aspectRatio: "1:1", n: 1 }),
      (err) => err.code === "not_configured" && !err.message.includes(secret),
    );
    assert.equal(called, false);
  });

  await check("JSON errors are not returned as images and the key stays out", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    delete process.env.POLLINATIONS_MODEL;
    const cases = [
      jsonResponse(401, { error: { message: `invalid ${secret}` } }),
      jsonResponse(402, { message: `payment required ${secret}` }),
      jsonResponse(400, { error: `rejected ${secret}` }),
      new Response(`{"error":"${secret}"}`, { status: 200, headers: { "content-type": "application/json" } }),
      new Response(`{"error":"${secret}"}`, { status: 200, headers: { "content-type": "image/png" } }),
    ];
    for (const response of cases) {
      globalThis.fetch = async (url, options) => {
        assert.equal(String(url).includes(secret), false);
        assert.equal(options.headers.Authorization, `Bearer ${secret}`);
        return response;
      };
      await assert.rejects(
        () => pollinationsProvider.generateImage({ prompt: "اختبار", aspectRatio: "1:1", n: 1 }),
        (err) => {
          assert.equal(err.message.includes(secret), false);
          assert.equal(String(err.buffer || ""), "");
          return true;
        },
      );
    }
  });
} finally {
  restoreEnv();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} provider checks passed`);
if (failed.length) process.exitCode = 1;
