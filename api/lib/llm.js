// api/lib/llm.js の中の schema を置き換え
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
        additionalProperties: false,          // ★ これが必須
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["prefecture","city","ward","town","village","unknown"] },
          prefecture: { type: "string" },     // 任意フィールド（必須にしない）
          municipality_code: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          latitude: { type: "number" },
          longitude: { type: "number" },
          score: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["name", "type", "score"]
      }
    }
  },
  required: ["input", "normalized", "candidates"]
};
