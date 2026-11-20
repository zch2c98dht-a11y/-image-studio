import { mockProvider } from "./mock.js";
import { openaiProvider } from "./openai.js";
import { pollinationsProvider } from "./pollinations.js";
import { xaiProvider } from "./xai.js";

export const DEFAULT_PROVIDER = "pollinations";

const providers = {
  pollinations: pollinationsProvider,
  mock: mockProvider,
  xai: xaiProvider,
  openai: openaiProvider,
};

export function providerName() {
  return (process.env.PROVIDER || DEFAULT_PROVIDER).toLowerCase().trim();
}

export function getProvider() {
  const name = providerName();
  const provider = providers[name];
  if (!provider) {
    const err = new Error(`مزود غير معروف: ${name}. استخدم pollinations أو xai أو mock أو openai.`);
    err.code = "not_configured";
    throw err;
  }
  return provider;
}

export function providerCapabilities() {
  const provider = getProvider();
  return {
    id: provider.id,
    supportsVideo: !!provider.supportsVideo,
    maxCount: provider.maxCount || 10,
  };
}

export { providers };
