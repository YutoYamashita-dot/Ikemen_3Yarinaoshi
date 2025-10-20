// api/lib/llm.js
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function searchRegionsLLM(
  userKeyword,
  { lang = "ja", limit = 10, model = "gpt-5-mini" } = {}
) {
  // ─────────────────────────────────────────────
  // Structured Outputs 用スキーマ（OpenAI v2 仕様準拠）
  // ─────────────────────────────────────────────
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["input", "normalized", "candidates"],
    properties: {
      input: { type: "string" },
      normalized: { type: "string" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "type",
            "prefecture",
            "municipality_code",
            "aliases",
            "latitude",
            "longitude",
            "score"
          ],
          properties: {
            name: { type: "string" },
            type: {
              type: "string",
              enum: ["prefecture", "city", "ward", "town", "village", "unknown"],
            },
            prefecture: { type: "string" },
            municipality_code: { type: "string" },
            aliases: {
              type: "array",
              items: { type: "string" },
            },
            latitude: { type: "number" },
            longitude: { type: "number" },
            score: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  };

  // ─────────────────────────────────────────────
  // ChatGPT-5 API 呼び出し
  // ─────────────────────────────────────────────
  const res = await client.chat.completions.create({
    model,
    response_format: {
      type: "json_schema",
      json_schema: { name: "RegionSearch", schema, strict: true },
    },
    messages: [
      {
        role: "system",
        content: `あなたは日本の地名検索エージェントです。曖昧な地名を解釈し、候補を最大${limit}件JSONで返してください。`,
      },
      {
        role: "user",
        content: `言語:${lang}\n地名キーワード:${userKeyword}\n出力はJSONのみ。`,
      },
    ],
  });

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

module.exports = { searchRegionsLLM };
