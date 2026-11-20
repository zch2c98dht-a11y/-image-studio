/**
 * محوّل OpenAI غير مكتمل (واجهة فقط).
 * يمكن إكماله لاحقاً باستدعاء api.openai.com مع المفتاح من متغير بيئة على الخادم.
 */
export const openaiProvider = {
  id: "openai",
  supportsVideo: false,
  async generateImage() {
    const err = new Error(
      "مزود OpenAI غير مفعّل بعد. استخدم PROVIDER=pollinations أو PROVIDER=xai أو PROVIDER=mock، أو أكمل محوّل openai لاحقاً.",
    );
    err.code = "not_implemented";
    throw err;
  },
  async generateVideo() {
    const err = new Error(
      "مزود OpenAI غير مفعّل بعد. استخدم PROVIDER=pollinations أو PROVIDER=xai أو PROVIDER=mock، أو أكمل محوّل openai لاحقاً.",
    );
    err.code = "not_implemented";
    throw err;
  },
};
