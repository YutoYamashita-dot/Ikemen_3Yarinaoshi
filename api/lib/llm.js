// api/lib/llm.js
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function searchRegionsLLM(userKeyword, { lang = "ja", limit = 10, model = "gpt-5-mini" } = {}) {
  const schema = {
    type: "object",
    properties: {
      input: { type: "string" },
      normalized: { type: "string" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string" },
            prefecture: { type: "string", nullable: true },
            municipality_code: { type: "string", nullable: true },
            aliases: { type: "array", items: { type: "string" } },
            latitude: { type: "number", nullable: true },
            longitude: { type: "number", nullable: true },
            score: { type: "number", minimum: 0, maximum: 1 }
          },
          required: ["name", "type", "score"]
        }
      }
    },
    required: ["input", "normalized", "candidates"],
    additionalProperties: false
  };

  const res = await client.chat.completions.create({
    model,
    response_format: { type: "json_schema", json_schema: { name: "RegionSearch", schema, strict: true } },
    messages: [
      { role: "system", content: `あなたは日本の地名検索エージェントです。候補は最大${limit}件。返答はJSONのみ。` },
      { role: "user", content: `言語:${lang}\n地名キーワード:${userKeyword}\n出力はJSONのみ。` }
    ],
    temperature: 0.3
  });

  const content = res.choices?.[0]?.message?.content?.trim() || "{}";
  try {
    const json = JSON.parse(content);
    json.candidates = Array.isArray(json.candidates) ? json.candidates.slice(0, limit) : [];
    return json;
  } catch {
    return { input: userKeyword, normalized: userKeyword, candidates: [] };
  }
}

// ← これが重要（CommonJS）
module.exports = { searchRegionsLLM };
