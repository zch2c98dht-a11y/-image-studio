/**
 * خطاف سياسة محتوى أساسي على مستوى التطبيق.
 * يرفع وضع المدير حدود الاستخدام فقط، ولا يتجاوز هذه القواعد
 * ولا سياسة المزود (xAI أو غيره).
 */

const SEXUAL_PATTERNS = [
  /porn/i,
  /porno/i,
  /\bxxx\b/i,
  /\bnsfw\b/i,
  /\bonlyfans\b/i,
  /nud(e|ity|es)\b/i,
  /naked/i,
  /lingerie/i,
  /bikini/i,
  /swimsuit/i,
  /underwear/i,
  /sex\s*tape/i,
  /\bsexual\b/i,
  /\berotic\b/i,
  /\blewd\b/i,
  /\bhentai\b/i,
  /\becchi\b/i,
  /explicit/i,
  /genitals?/i,
  /\bpenis\b/i,
  /\bvagina\b/i,
  /\bbreasts?\b/i,
  /\bbusty\b/i,
  /\bnipples?\b/i,
  /عم[يى]ق/i,
  /إباحي|اباحي/i,
  /جنس(?:ي|ية)?/i,
  /عاري(?:ة|ات)?/i,
  /تعري/i,
  /عري/i,
  /سكس/i,
  /إغراء|اغراء/i,
  /إباحية|اباحية/i,
  /بورن/i,
  /هنتاي/i,
  /صدر عار/i,
  /ثدي/i,
  /بكيني/i,
  /مايوه/i,
  /ملابس داخلية/i,
];

// طلبات لمشاهير أو أشخاص حقيقيين معروفين. القائمة قابلة للتوسيع عبر EXTRA_BLOCKLIST.
const CELEBRITY_PATTERNS = [
  /مشهور(?:ة)? حقيقي/i,
  /شخص(?:ية)? حقيقي/i,
  /real[- ]?life (person|celebrity|people)/i,
  /photo[- ]?real (celebrity|person)/i,
  /a photo of [A-Z][a-z]+ [A-Z][a-z]+/,
  /صورة (حقيقية|لـ?الممثل|لـ?الممثلة|لـ?اللاعب|لـ?اللاعبة|لـ?المغني|لـ?المغنية)/i,
  /كريستيانو|رونالدو|\bcr7\b|cristiano|ronaldo/i,
  /ليونيل|ميسي|\bmessi\b|lionel messi/i,
  /محمد صلاح|mo salah/i,
  /نيمار|\bneymar\b/i,
  /جورجينا|georgina rodr[ií]guez/i,
  /كيم كارداشيان|kim kardashian/i,
  /تايلور سويفت|taylor swift/i,
  /بيونسيه|beyonc[eé]/i,
  /إيلون ماسك|elon musk/i,
  /دونالد ترامب|donald trump/i,
  /جو بايدن|joe biden/i,
  /محمد بن سلمان|بن سلمان|\bmbs\b/i,
  /باراك أوباما|barack obama/i,
  /أنجلينا جولي|angelina jolie/i,
  /براد بيت|brad pitt/i,
  /توم كروز|tom cruise/i,
  /زندايا|\bzendaya\b/i,
  /ريهانا|\brihanna\b/i,
  /جونى ديب|جوني ديب|johnny depp/i,
  /شيرين عبد الوهاب/i,
  /عمرو دياب/i,
  /تامر حسني/i,
  /نانسي عجرم/i,
  /إلهام علييف|elham/i,
];

function extraPatterns() {
  const raw = process.env.EXTRA_BLOCKLIST || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new RegExp(s, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function moderatePrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    return { allowed: false, reason: "empty", message: "اكتب وصفاً للصورة أو الفيديو." };
  }
  if (text.length > 2000) {
    return { allowed: false, reason: "too_long", message: "الوصف طويل جداً. اختصره تحت ألفين حرف." };
  }

  const sexual = [...SEXUAL_PATTERNS, ...extraPatterns()].find((re) => re.test(text));
  if (sexual) {
    return {
      allowed: false,
      reason: "sexual_content",
      message: "هذا الطلب يخالف سياسة المحتوى. لا يمكن إنشاء صور أو فيديوهات جنسية أو عارية.",
    };
  }

  const celeb = CELEBRITY_PATTERNS.find((re) => re.test(text));
  if (celeb) {
    return {
      allowed: false,
      reason: "celebrity",
      message: "لا يمكن إنشاء صور أو فيديوهات لمشاهير أو أشخاص حقيقيين معروفين.",
    };
  }

  return { allowed: true, reason: null, message: null };
}

export function moderationPolicyNote() {
  return "سياسة المحتوى تُطبَّق على الجميع، بما في ذلك المدير. وضع المدير يرفع حدود العدد والاستخدام اليومي فقط.";
}
