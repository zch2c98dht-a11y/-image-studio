import assert from "node:assert/strict";
import { finalizePrompt, hasNonLatinLetters, prepareImagePrompt } from "../src/prompt-prep.js";

const secret = "sk_test_pollinations_should-never-leak";
const originalKey = process.env.POLLINATIONS_API_KEY;
const originalPrep = process.env.PROMPT_PREP;
const originalModel = process.env.POLLINATIONS_TEXT_MODEL;

const results = [];

function textResponse(body, status = 200, type = "text/plain") {
  return new Response(body, { status, headers: { "content-type": type } });
}

async function check(name, fn) {
  delete process.env.PROMPT_PREP;
  delete process.env.POLLINATIONS_TEXT_MODEL;
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
  if (originalPrep === undefined) delete process.env.PROMPT_PREP;
  else process.env.PROMPT_PREP = originalPrep;
  if (originalModel === undefined) delete process.env.POLLINATIONS_TEXT_MODEL;
  else process.env.POLLINATIONS_TEXT_MODEL = originalModel;
}

try {
  await check("detects Arabic and other non-Latin letters", async () => {
    assert.equal(hasNonLatinLetters("ناروتو"), true);
    assert.equal(hasNonLatinLetters("猫"), true);
    assert.equal(hasNonLatinLetters("a red bicycle"), false);
    assert.equal(hasNonLatinLetters("cafe 123"), false);
  });

  await check("Arabic prompt is translated and enhanced in one Pollinations call", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    const calls = [];
    const prepared = await prepareImagePrompt({
      prompt: "ناروتو",
      style: "سينمائي",
      enhance: true,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return textResponse(
          "Naruto, the anime ninja, in a cinematic night scene, dramatic lighting, highly detailed, sharp focus, high resolution",
        );
      },
    });
    assert.equal(calls.length, 1);
    const parsed = new URL(calls[0].url);
    assert.equal(parsed.origin, "https://gen.pollinations.ai");
    assert.equal(parsed.pathname.startsWith("/text/"), true);
    assert.match(parsed.searchParams.get("system"), /highly detailed/);
    assert.match(parsed.searchParams.get("system"), /lighting/);
    assert.match(parsed.searchParams.get("system"), /franchise name/);
    assert.match(parsed.searchParams.get("system"), /Masashi Kishimoto art style/);
    assert.match(parsed.searchParams.get("system"), /hair color, eyes/);
    assert.match(parsed.searchParams.get("system"), /two characters are fighting/);
    assert.match(decodeURIComponent(parsed.pathname), /ناروتو/);
    assert.equal(parsed.searchParams.get("model"), "openai");
    assert.equal(calls[0].url.includes(secret), false);
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
    assert.match(prepared.promptEn, /Naruto/);
    assert.match(prepared.promptEn, /Official anime screenshot/);
    assert.match(prepared.promptEn, /Naruto Shippuden/);
    assert.match(prepared.promptEn, /spiky blond hair/);
    assert.match(prepared.providerPrompt, /highly detailed, sharp focus, high resolution/);
    assert.equal(prepared.providerPrompt.includes(secret), false);
    assert.equal(prepared.source, "llm");
  });

  await check("non-2xx model response retries once with openai-fast", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    const models = [];
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const prepared = await prepareImagePrompt({
        prompt: "ناروتو يقاتل ساسكي",
        enhance: true,
        fetchImpl: async (url) => {
          const parsed = new URL(String(url));
          models.push(parsed.searchParams.get("model"));
          assert.equal(String(url).includes(secret), false);
          if (models.length === 1) return textResponse("missing", 404, "application/json");
          return textResponse(
            "Naruto and Sasuke fighting, Naruto anime, Masashi Kishimoto art style, highly detailed, sharp focus, high resolution",
          );
        },
      });
      assert.deepEqual(models, ["openai", "openai-fast"]);
      assert.equal(prepared.source, "llm");
      assert.match(prepared.promptEn, /Naruto and Sasuke/);
      assert.equal(logs.some((line) => line === "prompt-prep path=llm"), true);
      assert.equal(logs.some((line) => line.includes(secret)), false);
    } finally {
      console.log = originalLog;
    }
  });

  await check("English prompts are enhanced too", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    let system = "";
    const prepared = await prepareImagePrompt({
      prompt: "a red bicycle",
      style: "واقعي",
      enhance: true,
      fetchImpl: async (url) => {
        system = new URL(String(url)).searchParams.get("system");
        return textResponse(
          "A red bicycle on a quiet street, realistic style, soft morning light, balanced composition, highly detailed, sharp focus, high resolution",
        );
      },
    });
    assert.match(system, /If the user text is not English, translate it first/);
    assert.match(prepared.promptEn, /red bicycle/);
    assert.match(prepared.promptEn, /highly detailed, sharp focus, high resolution/);
  });

  await check("enhancement off still translates Arabic and leaves English unchanged", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    let system = "";
    const arabic = await prepareImagePrompt({
      prompt: "ناروتو",
      enhance: false,
      fetchImpl: async (url) => {
        system = new URL(String(url)).searchParams.get("system");
        return textResponse("Naruto, the anime character");
      },
    });
    assert.match(system, /Translate to a concise English image prompt/);
    assert.doesNotMatch(system, /highly detailed/);
    assert.equal(arabic.promptEn, "Naruto, the anime character");

    let called = false;
    const english = await prepareImagePrompt({
      prompt: "a red bicycle",
      style: "واقعي",
      enhance: false,
      fetchImpl: async () => {
        called = true;
        return textResponse("should not be used");
      },
    });
    assert.equal(called, false);
    assert.equal(english.promptEn, null);
    assert.match(english.providerPrompt, /a red bicycle/);
    assert.match(english.providerPrompt, /Art style: واقعي/);
  });

  await check("keyless fallback translates when Pollinations fails", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    const hosts = [];
    const prepared = await prepareImagePrompt({
      prompt: "ناروتو",
      enhance: true,
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        hosts.push(parsed.hostname);
        assert.equal(String(url).includes(secret), false);
        if (parsed.hostname === "gen.pollinations.ai") {
          return textResponse(JSON.stringify({ error: `bad ${secret}` }), 401, "application/json");
        }
        if (parsed.hostname === "translate.googleapis.com") {
          return textResponse(JSON.stringify([[["Naruto the ninja", "ناروتو"]]]), 200, "application/json");
        }
        throw new Error("unexpected host");
      },
    });
    assert.deepEqual(hosts, ["gen.pollinations.ai", "gen.pollinations.ai", "translate.googleapis.com"]);
    assert.match(prepared.promptEn, /Naruto the ninja, highly detailed, sharp focus, high resolution/);
    assert.match(prepared.promptEn, /Official anime screenshot/);
    assert.equal(prepared.source, "gtx");
    assert.equal(prepared.category, "anime");
    assert.match(prepared.providerPrompt, /highly detailed, sharp focus, high resolution/);
    assert.equal(prepared.providerPrompt.includes(secret), false);
  });

  await check("MyMemory is used when Google fails, and total failure keeps the original", async () => {
    delete process.env.POLLINATIONS_API_KEY;
    const prepared = await prepareImagePrompt({
      prompt: "ناروتو",
      enhance: true,
      fetchImpl: async (url) => {
        const host = new URL(String(url)).hostname;
        if (host === "translate.googleapis.com") return textResponse("nope", 503, "text/plain");
        if (host === "api.mymemory.translated.net") {
          return textResponse(
            JSON.stringify({ responseData: { translatedText: "Naruto" } }),
            200,
            "application/json",
          );
        }
        throw new Error(`unexpected ${host}`);
      },
    });
    assert.match(prepared.promptEn, /Naruto, highly detailed, sharp focus, high resolution/);
    assert.match(prepared.promptEn, /spiky blond hair/);
    assert.equal(prepared.source, "mymemory");

    const failed = await prepareImagePrompt({
      prompt: "ناروتو",
      enhance: true,
      timeoutMs: 400,
      fetchImpl: (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    assert.equal(failed.source, "original");
    assert.equal(failed.promptEn, null);
    assert.match(failed.providerPrompt, /ناروتو/);
  });

  await check("moderation runs on the original and the rewritten prompt", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    let calls = 0;
    const blockedOriginal = await finalizePrompt({
      prompt: "صورة إباحية عارية",
      enhance: true,
      fetchImpl: async () => {
        calls += 1;
        return textResponse("should not run");
      },
    });
    assert.equal(blockedOriginal.ok, false);
    assert.equal(blockedOriginal.moderation.reason, "sexual_content");
    assert.equal(calls, 0);

    const blockedTranslation = await finalizePrompt({
      prompt: "قطة لطيفة",
      enhance: true,
      fetchImpl: async () => textResponse("nude erotic portrait of a cat, highly detailed"),
    });
    assert.equal(blockedTranslation.ok, false);
    assert.equal(blockedTranslation.moderation.reason, "sexual_content");

    const blockedName = await finalizePrompt({
      prompt: "شخص يحتفل",
      enhance: false,
      fetchImpl: async () => textResponse("cristiano ronaldo celebrating"),
    });
    assert.equal(blockedName.ok, false);
    assert.equal(blockedName.moderation.reason, "celebrity");

    const allowed = await finalizePrompt({
      prompt: "ناروتو",
      enhance: true,
      fetchImpl: async (url) => {
        assert.equal(String(url).includes(secret), false);
        return textResponse("Naruto, the anime ninja, highly detailed, sharp focus, high resolution");
      },
    });
    assert.equal(allowed.ok, true);
    assert.match(allowed.promptEn, /Naruto/);
    assert.equal(allowed.promptEn.includes(secret), false);
  });

  await check("a leaked key in the model text is removed", async () => {
    process.env.POLLINATIONS_API_KEY = secret;
    const prepared = await prepareImagePrompt({
      prompt: "ناروتو",
      enhance: true,
      fetchImpl: async (url, options) => {
        assert.equal(String(url).includes(secret), false);
        assert.equal(options.headers.Authorization, `Bearer ${secret}`);
        return textResponse(`Naruto portrait ${secret} highly detailed, sharp focus, high resolution`);
      },
    });
    assert.equal(prepared.promptEn.includes(secret), false);
    assert.match(prepared.promptEn, /Naruto portrait/);
  });
} finally {
  restoreEnv();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} prompt checks passed`);
if (failed.length) process.exitCode = 1;
