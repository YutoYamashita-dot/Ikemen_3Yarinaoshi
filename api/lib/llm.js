// api/lib/llm.js
const OpenAI = require("openai");

// ─────────────────────────────────────────────
// OpenAIクライアント
// ─────────────────────────────────────────────
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ─────────────────────────────────────────────
// 地域検索（ChatGPT-5 API 版）
// ─────────────────────────────────────────────
async function searchRegionsLLM(
  userKeyword,
  { lang = "ja", limit = 10, model = "gpt-5-mini" } = {}
) {
  // GPT-5 Structured Outputs 用のJSONスキーマ
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      input: { type: "string" },
      normalized: { type: "string" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            type: {
              type: "string",
              enum: ["prefecture", "city", "ward", "town", "village", "unknown"],
            },
            prefecture: { type: "string" },
            municipality_code: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            latitude: { type: "number" },
            longitude: { type: "number" },
            score: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["name", "type", "score"],
        },
      },
    },
    required: ["input", "normalized", "candidates"],
  };

  // GPT-5呼び出し
  const res = await client.chat.completions.create({
    model, // 例: gpt-5 または gpt-5-mini
    response_format: {
      type: "json_schema",
      json_schema: { name: "RegionSearch", schema, strict: true },
    },
    messages: [
      {
        role: "system",
        content: `あなたは日本の地名検索エージェントです。候補は最大${limit}件。返答はJSONのみ。`,
      },
      {
        role: "user",
        content: `言語:${lang}\n地名キーワード:${userKeyword}\n出力はJSONのみ。`,
      },
    ],
  });

  // 応答の整形
  const content = res.choices?.[0]?.message?.content?.trim() || "{}";
  try {
    const json = JSON.parse(content);
    json.candidates = Array.isArray(json.candidates)
      ? json.candidates.slice(0, limit)
      : [];
    return json;
  } catch {
    return { input: userKeyword, normalized: userKeyword, candidates: [] };
  }
}

// ─────────────────────────────────────────────
// CommonJS 形式でエクスポート
// ─────────────────────────────────────────────
module.exports = { searchRegionsLLM };

